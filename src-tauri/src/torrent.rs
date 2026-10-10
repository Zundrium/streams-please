use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use librqbit::{
    api::{Api, TorrentIdOrHash},
    http_api::{HttpApi, HttpApiOptions},
    AddTorrent, AddTorrentOptions, Magnet, Session, SessionOptions, SessionPersistenceConfig,
};
use serde::Serialize;
use tauri::{Manager, State};
use tokio::net::TcpListener;

use crate::seeding::{prepare_session_directory, purge_orphaned_media, SeedingManager};

const MAX_MAGNET_LENGTH: usize = 32_768;
const STREAMABLE_FILES_PATTERN: &str =
    r"(?i)\.(mkv|mk3d|mp4|m4v|mov|webm|avi|ts|m2ts|srt|vtt|ass|ssa)$";

pub struct TorrentState {
    api: Api,
    stream_port: u16,
    download_dir: PathBuf,
    seeding: Arc<SeedingManager>,
}

fn session_options(session_dir: &Path) -> SessionOptions {
    SessionOptions {
        fastresume: true,
        persistence: Some(SessionPersistenceConfig::Json {
            folder: Some(session_dir.to_path_buf()),
        }),
        ..Default::default()
    }
}

async fn start_session(download_dir: &Path, session_dir: &Path) -> Result<Arc<Session>, String> {
    prepare_session_directory(session_dir, download_dir);
    match Session::new_with_opts(download_dir.to_path_buf(), session_options(session_dir)).await {
        Ok(session) => Ok(session),
        Err(error) => {
            eprintln!("resetting the saved torrent session after a restore failure: {error:#}");
            if let Err(error) = std::fs::remove_dir_all(session_dir) {
                eprintln!("could not reset the saved torrent session: {error}");
            }
            Session::new_with_opts(download_dir.to_path_buf(), session_options(session_dir))
                .await
                .map_err(|error| error.to_string())
        }
    }
}

fn magnet_info_hash(magnet: &str) -> Result<String, String> {
    Magnet::parse(magnet)
        .ok()
        .and_then(|magnet| magnet.as_id20())
        .map(|id| id.as_string())
        .ok_or_else(|| "Enter a valid BitTorrent magnet link with a v1 info hash.".to_string())
}

impl TorrentState {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?;
        let download_dir = cache_dir.join("media");
        let session_dir = cache_dir.join("session");
        std::fs::create_dir_all(&download_dir).map_err(|error| error.to_string())?;

        tauri::async_runtime::block_on(async {
            let session = start_session(&download_dir, &session_dir).await?;
            let restored: HashSet<String> = session.with_torrents(|torrents| {
                torrents
                    .map(|(_, handle)| handle.info_hash().as_string())
                    .collect()
            });
            purge_orphaned_media(&download_dir, &restored);
            let api = Api::new(session, None, None);
            let seeding = SeedingManager::new(api.clone(), download_dir.clone(), &cache_dir);
            seeding.spawn_reconciler();
            let listener = TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|error| error.to_string())?;
            let stream_port = listener
                .local_addr()
                .map_err(|error| error.to_string())?
                .port();

            let server = HttpApi::new(
                api.clone(),
                Some(HttpApiOptions {
                    read_only: true,
                    basic_auth: None,
                }),
            );
            tauri::async_runtime::spawn(async move {
                if let Err(error) = server.make_http_api_and_run(listener, None).await {
                    eprintln!("local torrent stream server stopped: {error:#}");
                }
            });

            Ok(Self {
                api,
                stream_port,
                download_dir,
                seeding,
            })
        })
    }

    pub fn stream_port(&self) -> u16 {
        self.stream_port
    }

    pub fn download_dir(&self) -> &Path {
        &self.download_dir
    }

    pub fn seeding(&self) -> &SeedingManager {
        &self.seeding
    }
}

fn validate_magnet(magnet: &str) -> Result<(), String> {
    let trimmed = magnet.trim();
    if trimmed.len() > MAX_MAGNET_LENGTH {
        return Err("The magnet link is unexpectedly long.".into());
    }
    if !trimmed.starts_with("magnet:?") || !trimmed.contains("xt=urn:btih:") {
        return Err("Enter a valid BitTorrent magnet link with an info hash.".into());
    }
    Ok(())
}

fn parse_have_pieces(debug_bitfield: &str) -> Vec<bool> {
    let Some(start) = debug_bitfield.rfind('[') else {
        return Vec::new();
    };
    let Some(end) = debug_bitfield.rfind(']') else {
        return Vec::new();
    };
    if end <= start {
        return Vec::new();
    }

    debug_bitfield[start + 1..end]
        .split(',')
        .filter_map(|value| match value.trim() {
            "0" => Some(false),
            "1" => Some(true),
            _ => None,
        })
        .collect()
}

#[tauri::command]
pub async fn add_magnet(
    state: State<'_, TorrentState>,
    magnet: String,
) -> Result<serde_json::Value, String> {
    validate_magnet(&magnet)?;
    let info_hash = magnet_info_hash(magnet.trim())?;
    let options = AddTorrentOptions {
        only_files_regex: Some(STREAMABLE_FILES_PATTERN.into()),
        overwrite: true,
        sub_folder: Some(info_hash.clone()),
        ..Default::default()
    };

    state.seeding.begin_stream(&info_hash).await;
    let response = match start_streaming_torrent(&state.api, magnet.trim(), options).await {
        Ok(response) => response,
        Err(error) => {
            state.seeding.stream_failed(&info_hash).await;
            return Err(error);
        }
    };
    state
        .seeding
        .stream_started(&info_hash, response.details.name.clone())
        .await;
    let seeding = Arc::clone(&state.seeding);
    tauri::async_runtime::spawn(async move { seeding.reconcile().await });

    serde_json::to_value(response).map_err(|error| error.to_string())
}

async fn start_streaming_torrent(
    api: &Api,
    magnet: &str,
    options: AddTorrentOptions,
) -> Result<librqbit::api::ApiAddTorrentResponse, String> {
    let response = api
        .api_add_torrent(AddTorrent::from_url(magnet), Some(options))
        .await
        .map_err(|error| format!("The torrent could not be started: {error}"))?;
    let id = response
        .id
        .ok_or_else(|| "The torrent engine did not return a session ID.".to_string())?;
    let paused = api
        .mgr_handle(TorrentIdOrHash::Id(id))
        .map(|handle| handle.is_paused())
        .unwrap_or(false);
    if paused {
        api.api_torrent_action_start(TorrentIdOrHash::Id(id))
            .await
            .map_err(|error| format!("The cached episode could not be resumed: {error}"))?;
    }
    Ok(response)
}

#[tauri::command]
pub async fn torrent_status(
    state: State<'_, TorrentState>,
    id: usize,
) -> Result<serde_json::Value, String> {
    let response = state
        .api
        .api_stats_v1(TorrentIdOrHash::Id(id))
        .map_err(|error| error.to_string())?;
    let mut value = serde_json::to_value(response).map_err(|error| error.to_string())?;

    if let Ok(debug_bitfield) = state.api.api_dump_haves(TorrentIdOrHash::Id(id)) {
        let pieces = parse_have_pieces(&debug_bitfield);
        if !pieces.is_empty() {
            value
                .as_object_mut()
                .ok_or_else(|| "Torrent stats did not serialize to an object.".to_string())?
                .insert("pieces".to_string(), serde_json::Value::from(pieces));
        }
    }

    Ok(value)
}

#[tauri::command]
pub async fn stream_url(
    state: State<'_, TorrentState>,
    id: usize,
    file_id: usize,
) -> Result<String, String> {
    let stream = state
        .api
        .api_stream(TorrentIdOrHash::Id(id), file_id)
        .map_err(|error| format!("The video file cannot be streamed: {error}"))?;
    if stream.len() == 0 {
        return Err("The selected video file is empty.".into());
    }

    Ok(format!(
        "http://127.0.0.1:{}/torrents/{id}/stream/{file_id}",
        state.stream_port
    ))
}

#[tauri::command]
pub async fn release_torrent(state: State<'_, TorrentState>, id: usize) -> Result<(), String> {
    state.seeding.release(id).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSpeeds {
    download_mbps: f64,
    upload_mbps: f64,
}

#[tauri::command]
pub fn transfer_speeds(state: State<'_, TorrentState>) -> TransferSpeeds {
    let stats = state.api.session().stats_snapshot();
    TransferSpeeds {
        download_mbps: stats.download_speed.mbps,
        upload_mbps: stats.upload_speed.mbps,
    }
}

#[cfg(test)]
mod tests {
    use super::{magnet_info_hash, parse_have_pieces, validate_magnet};

    #[test]
    fn accepts_v1_magnet_links() {
        assert!(validate_magnet("magnet:?xt=urn:btih:0123456789abcdef").is_ok());
    }

    #[test]
    fn rejects_non_magnet_input() {
        assert!(validate_magnet("https://example.com/video.mkv").is_err());
    }

    #[test]
    fn rejects_oversized_magnet_links() {
        let magnet = format!("magnet:?xt=urn:btih:{}", "a".repeat(32_768));
        assert!(validate_magnet(&magnet).is_err());
    }

    #[test]
    fn extracts_lowercase_info_hash_from_magnets() {
        assert_eq!(
            magnet_info_hash(
                "magnet:?xt=urn:btih:08ADA5A7A6183AAE1E09D831DF6748D566095A10&dn=Sintel"
            )
            .as_deref(),
            Ok("08ada5a7a6183aae1e09d831df6748d566095a10")
        );
        assert!(magnet_info_hash("magnet:?xt=urn:btih:0123").is_err());
    }

    #[test]
    fn parses_librqbit_have_piece_debug_output() {
        let debug =
            "BitSlice<u8, bitvec::order::Msb0> { addr: 0x1, head: 000, bits: 5 } [1, 0, 1, 1, 0]";
        assert_eq!(
            parse_have_pieces(debug),
            vec![true, false, true, true, false]
        );
        assert!(parse_have_pieces("not a bitfield").is_empty());
    }
}
