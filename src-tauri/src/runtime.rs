use std::path::PathBuf;

use serde::Serialize;
use tauri::{Manager, State};

use crate::torrent::TorrentState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    engine: &'static str,
    engine_version: &'static str,
    stream_port: u16,
    download_dir: String,
    mpv_available: bool,
    mpv_version: Option<String>,
    trailer_available: bool,
    trailer_runtime_version: Option<String>,
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

pub fn configure_bundled_media_tools() {
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
pub async fn runtime_info(
    app: tauri::AppHandle,
    state: State<'_, TorrentState>,
) -> Result<RuntimeInfo, String> {
    let stream_port = state.stream_port();
    let download_dir = state.download_dir().to_string_lossy().into_owned();
    let (mpv_available, trailer_available) = tauri::async_runtime::spawn_blocking(move || {
        (
            libmpv_available(&app),
            trailer_runtime_dir(Some(&app)).is_some(),
        )
    })
    .await
    .map_err(|error| format!("The bundled runtimes could not be inspected: {error}"))?;

    Ok(RuntimeInfo {
        engine: "librqbit",
        engine_version: librqbit::version(),
        stream_port,
        download_dir,
        mpv_available,
        mpv_version: mpv_available.then(|| "libmpv (in-process)".to_string()),
        trailer_available,
        trailer_runtime_version: trailer_available
            .then(|| "yt-dlp 2026.07.04 + Deno 2.9.3".to_string()),
    })
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    #[test]
    fn bundled_trailer_runtime_is_present_for_desktop_development() {
        assert!(super::trailer_runtime_dir(None).is_some());
    }
}
