use std::{
    collections::HashSet,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use librqbit::{
    api::{Api, TorrentIdOrHash},
    http_api::{HttpApi, HttpApiOptions},
    AddTorrent, AddTorrentOptions, Session,
};
use serde::Serialize;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::net::TcpListener;

mod catalog;
mod updates;
const LIBRARY_EXPORT_FORMAT: &str = "streamsplease-library";
const LIBRARY_EXPORT_VERSION: u64 = 1;
const MAX_LIBRARY_FILE_BYTES: usize = 5_000_000;

struct TorrentState {
    api: Api,
    stream_port: u16,
    download_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    engine: &'static str,
    engine_version: &'static str,
    stream_port: u16,
    download_dir: String,
    mpv_available: bool,
    mpv_version: Option<String>,
    trailer_available: bool,
    trailer_runtime_version: Option<String>,
}

fn validate_magnet(magnet: &str) -> Result<(), String> {
    let trimmed = magnet.trim();
    if trimmed.len() > 32_768 {
        return Err("The magnet link is unexpectedly long.".into());
    }
    if !trimmed.starts_with("magnet:?") || !trimmed.contains("xt=urn:btih:") {
        return Err("Enter a valid BitTorrent magnet link with an info hash.".into());
    }
    Ok(())
}

fn runtime_search_dirs(app: Option<&tauri::AppHandle>) -> Vec<PathBuf> {
    let mut search_dirs = Vec::new();

    if let Some(app) = app {
        if let Ok(resource_dir) = app.path().resource_dir() {
            search_dirs.push(resource_dir.join("lib"));
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(executable_dir) = executable.parent() {
            search_dirs.push(executable_dir.join("lib"));
        }
    }
    if cfg!(debug_assertions) {
        search_dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("lib"));
    }

    search_dirs
}

fn libmpv_available(app: &tauri::AppHandle) -> bool {
    runtime_search_dirs(Some(app)).into_iter().any(|directory| {
        #[cfg(target_os = "windows")]
        return directory.join("libmpv-wrapper.dll").is_file()
            && directory.join("libmpv-2.dll").is_file();

        #[cfg(target_os = "macos")]
        return directory.join("libmpv-wrapper.dylib").is_file();

        #[cfg(target_os = "linux")]
        return directory.join("libmpv-wrapper.so").is_file();

        #[allow(unreachable_code)]
        false
    })
}

fn trailer_runtime_dir(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    runtime_search_dirs(app).into_iter().find(|directory| {
        #[cfg(target_os = "windows")]
        return directory.join("yt-dlp.exe").is_file() && directory.join("deno.exe").is_file();

        #[cfg(not(target_os = "windows"))]
        return directory.join("yt-dlp").is_file() && directory.join("deno").is_file();
    })
}

fn configure_bundled_media_tools() {
    let Some(directory) = trailer_runtime_dir(None) else {
        return;
    };
    let mut paths = vec![directory];
    if let Some(current_path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&current_path));
    }
    if let Ok(path) = std::env::join_paths(paths) {
        std::env::set_var("PATH", path);
    }
}

#[tauri::command]
fn runtime_info(app: tauri::AppHandle, state: State<'_, TorrentState>) -> RuntimeInfo {
    let mpv_available = libmpv_available(&app);
    let mpv_version = mpv_available.then(|| "libmpv (in-process)".to_string());
    let trailer_available = trailer_runtime_dir(Some(&app)).is_some();

    RuntimeInfo {
        engine: "librqbit",
        engine_version: librqbit::version(),
        stream_port: state.stream_port,
        download_dir: state.download_dir.to_string_lossy().into_owned(),
        mpv_available,
        mpv_version,
        trailer_available,
        trailer_runtime_version: trailer_available
            .then(|| "yt-dlp 2026.07.04 + Deno 2.9.3".to_string()),
    }
}

#[tauri::command]
async fn add_magnet(
    state: State<'_, TorrentState>,
    magnet: String,
) -> Result<serde_json::Value, String> {
    validate_magnet(&magnet)?;
    let api = state.api.clone();
    let options = AddTorrentOptions {
        // Avoid downloading artwork, archives, checksums, and other unrelated files.
        only_files_regex: Some(
            r"(?i)\.(mkv|mk3d|mp4|m4v|mov|webm|avi|ts|m2ts|srt|vtt|ass|ssa)$".into(),
        ),
        overwrite: true,
        ..Default::default()
    };

    let response = api
        .api_add_torrent(AddTorrent::from_url(magnet.trim()), Some(options))
        .await
        .map_err(|error| format!("The torrent could not be started: {error}"))?;

    serde_json::to_value(response).map_err(|error| error.to_string())
}

#[tauri::command]
fn torrent_details(state: State<'_, TorrentState>, id: usize) -> Result<serde_json::Value, String> {
    let response = state
        .api
        .api_torrent_details(TorrentIdOrHash::Id(id))
        .map_err(|error| error.to_string())?;
    serde_json::to_value(response).map_err(|error| error.to_string())
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
fn torrent_status(state: State<'_, TorrentState>, id: usize) -> Result<serde_json::Value, String> {
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
                .insert(
                    "pieces".to_string(),
                    serde_json::to_value(pieces).map_err(|error| error.to_string())?,
                );
        }
    }

    Ok(value)
}

#[tauri::command]
async fn stream_url(
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
async fn pause_torrent(state: State<'_, TorrentState>, id: usize) -> Result<(), String> {
    let api = state.api.clone();
    api.api_torrent_action_pause(TorrentIdOrHash::Id(id))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn resume_torrent(state: State<'_, TorrentState>, id: usize) -> Result<(), String> {
    let api = state.api.clone();
    api.api_torrent_action_start(TorrentIdOrHash::Id(id))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn forget_torrent(state: State<'_, TorrentState>, id: usize) -> Result<(), String> {
    let api = state.api.clone();
    api.api_torrent_action_forget(TorrentIdOrHash::Id(id))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn validate_library_export(source: &str) -> Result<(), String> {
    if source.len() > MAX_LIBRARY_FILE_BYTES {
        return Err("The library export is too large.".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(source).map_err(|_| "The library export is not valid JSON.")?;
    if value.get("format").and_then(serde_json::Value::as_str) != Some(LIBRARY_EXPORT_FORMAT)
        || value.get("version").and_then(serde_json::Value::as_u64) != Some(LIBRARY_EXPORT_VERSION)
    {
        return Err("The library export has an invalid format.".into());
    }
    let entries = value
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .filter(|entries| entries.len() <= 10_000)
        .ok_or("The library export has an invalid entries list.")?;

    let mut anilist_ids = HashSet::new();
    let mut slugs = HashSet::new();
    for entry in entries {
        let object = entry
            .as_object()
            .ok_or("The library export contains an invalid entry.")?;
        let slug = object
            .get("slug")
            .and_then(serde_json::Value::as_str)
            .ok_or("The library export contains an invalid entry.")?;
        catalog::subsplease::validate_subsplease_slug(slug)?;
        if !slugs.insert(slug) {
            return Err("The library export contains duplicate shows.".into());
        }
        if let Some(value) = object.get("anilistId") {
            let id = value
                .as_u64()
                .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
                .ok_or("The library export contains an invalid AniList ID.")?;
            if !anilist_ids.insert(id) {
                return Err("The library export contains duplicate shows.".into());
            }
        }
    }
    Ok(())
}

fn json_file_path(mut path: PathBuf, add_extension: bool) -> Result<PathBuf, String> {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("json") => Ok(path),
        None if add_extension => {
            path.set_extension("json");
            Ok(path)
        }
        _ => Err("Choose a JSON file.".into()),
    }
}

fn write_library_export(path: &Path, contents: &str) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or("The library export location is unavailable.")?;
    let mut file = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("The temporary library export could not be created: {error}"))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("The library export could not be written: {error}"))?;
    file.as_file()
        .sync_all()
        .map_err(|error| format!("The library export could not be finalized: {error}"))?;
    file.persist(path)
        .map_err(|error| format!("The library export could not be saved: {}", error.error))?;
    Ok(())
}

fn read_library_source(path: &Path) -> Result<String, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("The selected library file could not be inspected: {error}"))?;
    if metadata.len() > MAX_LIBRARY_FILE_BYTES as u64 {
        return Err("The selected library file is too large.".into());
    }

    let file = std::fs::File::open(path)
        .map_err(|error| format!("The selected library file could not be opened: {error}"))?;
    let mut source = String::new();
    file.take(MAX_LIBRARY_FILE_BYTES as u64 + 1)
        .read_to_string(&mut source)
        .map_err(|error| format!("The selected library file could not be read: {error}"))?;
    if source.len() > MAX_LIBRARY_FILE_BYTES {
        return Err("The selected library file is too large.".into());
    }
    Ok(source)
}

#[tauri::command]
async fn export_library_file(app: tauri::AppHandle, contents: String) -> Result<bool, String> {
    validate_library_export(&contents)?;
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Export StreamsPlease library")
        .set_file_name("streamsplease-library.json")
        .add_filter("JSON", &["json"])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = json_file_path(
        path.into_path()
            .map_err(|error| format!("The export location is unavailable: {error}"))?,
        true,
    )?;
    tauri::async_runtime::spawn_blocking(move || write_library_export(&path, &contents))
        .await
        .map_err(|error| format!("The library export could not be completed: {error}"))??;
    Ok(true)
}

#[tauri::command]
async fn import_library_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Import StreamsPlease library")
        .add_filter("JSON", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = json_file_path(
        path.into_path()
            .map_err(|error| format!("The selected file is unavailable: {error}"))?,
        false,
    )?;
    tauri::async_runtime::spawn_blocking(move || read_library_source(&path))
        .await
        .map_err(|error| format!("The library import could not be completed: {error}"))?
        .map(Some)
}

fn create_torrent_state(app: &tauri::AppHandle) -> Result<TorrentState, String> {
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

        Ok(TorrentState {
            api,
            stream_port,
            download_dir,
        })
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_bundled_media_tools();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let torrent_state = create_torrent_state(app.handle())
                .map_err(|error| format!("initializing torrent engine: {error}"))?;
            let catalog_state = catalog::CatalogState::new()
                .map_err(|error| format!("initializing catalog providers: {error}"))?;
            let update_state = updates::UpdateState::new()
                .map_err(|error| format!("initializing app updates: {error}"))?;
            app.manage(torrent_state);
            app.manage(catalog_state);
            app.manage(update_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            updates::check_for_update,
            updates::install_update,
            add_magnet,
            torrent_details,
            torrent_status,
            stream_url,
            pause_torrent,
            resume_torrent,
            forget_torrent,
            export_library_file,
            import_library_file,
            catalog::catalog_providers,
            catalog::catalog_request,
            catalog::subsplease::subsplease_schedule,
            catalog::subsplease::subsplease_index,
            catalog::subsplease::subsplease_show,
            catalog::anilist::anilist_season,
            catalog::anilist::anilist_search,
        ])
        .run(tauri::generate_context!())
        .expect("error while running StreamsPlease");
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::trailer_runtime_dir;
    use super::{parse_have_pieces, validate_library_export, validate_magnet};

    #[cfg(target_os = "windows")]
    #[test]
    fn bundled_trailer_runtime_is_present_for_desktop_development() {
        assert!(trailer_runtime_dir(None).is_some());
    }

    #[test]
    fn accepts_v1_magnet_links() {
        assert!(validate_magnet("magnet:?xt=urn:btih:0123456789abcdef").is_ok());
    }

    #[test]
    fn rejects_non_magnet_input() {
        assert!(validate_magnet("https://example.com/video.mkv").is_err());
    }

    #[test]
    fn validates_library_export_envelope() {
        assert!(validate_library_export(
            r#"{"format":"streamsplease-library","version":1,"entries":[]}"#
        )
        .is_ok());
        assert!(validate_library_export(
            r#"{"format":"streamsplease-library","version":1,"entries":[{"anilistId":1,"subspleaseId":2,"slug":"example-show","following":true,"watchedEpisodes":["01"],"addedAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]}"#
        )
        .is_ok());
        assert!(validate_library_export(r#"{"version":1,"entries":[]}"#).is_err());
        assert!(validate_library_export(
            r#"{"format":"streamsplease-library","version":2,"entries":[]}"#
        )
        .is_err());
        assert!(validate_library_export(
            r#"{"format":"streamsplease-library","version":1,"entries":[null]}"#
        )
        .is_err());
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
