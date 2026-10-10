use std::path::{Path, PathBuf};

use librqbit::{
    api::{Api, TorrentIdOrHash},
    http_api::{HttpApi, HttpApiOptions},
    AddTorrent, AddTorrentOptions, Session,
};
use tauri::{Manager, State};
use tokio::net::TcpListener;

const MAX_MAGNET_LENGTH: usize = 32_768;
const STREAMABLE_FILES_PATTERN: &str =
    r"(?i)\.(mkv|mk3d|mp4|m4v|mov|webm|avi|ts|m2ts|srt|vtt|ass|ssa)$";

pub struct TorrentState {
    api: Api,
    stream_port: u16,
    download_dir: PathBuf,
}

impl TorrentState {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let download_dir = app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?
            .join("media");
        std::fs::create_dir_all(&download_dir).map_err(|error| error.to_string())?;

        tauri::async_runtime::block_on(async {
            let session = Session::new(download_dir.clone())
                .await
                .map_err(|error| error.to_string())?;
            let api = Api::new(session, None, None);
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
            })
        })
    }

    pub fn stream_port(&self) -> u16 {
        self.stream_port
    }

    pub fn download_dir(&self) -> &Path {
        &self.download_dir
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
    let options = AddTorrentOptions {
        only_files_regex: Some(STREAMABLE_FILES_PATTERN.into()),
        overwrite: true,
        ..Default::default()
    };

    let response = state
        .api
        .api_add_torrent(AddTorrent::from_url(magnet.trim()), Some(options))
        .await
        .map_err(|error| format!("The torrent could not be started: {error}"))?;

    serde_json::to_value(response).map_err(|error| error.to_string())
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
pub async fn forget_torrent(state: State<'_, TorrentState>, id: usize) -> Result<(), String> {
    state
        .api
        .api_torrent_action_forget(TorrentIdOrHash::Id(id))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{parse_have_pieces, validate_magnet};

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
