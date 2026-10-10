use std::{
    collections::HashSet,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use tauri_plugin_dialog::DialogExt;

use crate::catalog;

const LIBRARY_EXPORT_FORMAT: &str = "streamsplease-library";
const LIBRARY_EXPORT_VERSION: u64 = 1;
const MAX_LIBRARY_FILE_BYTES: usize = 5_000_000;
const MAX_LIBRARY_ENTRIES: usize = 10_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

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
        .filter(|entries| entries.len() <= MAX_LIBRARY_ENTRIES)
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
                .filter(|id| *id > 0 && *id <= MAX_SAFE_INTEGER)
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

fn export_library(app: &tauri::AppHandle, contents: &str) -> Result<bool, String> {
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
    write_library_export(&path, contents)?;
    Ok(true)
}

fn import_library(app: &tauri::AppHandle) -> Result<Option<String>, String> {
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
    read_library_source(&path).map(Some)
}

#[tauri::command]
pub async fn export_library_file(app: tauri::AppHandle, contents: String) -> Result<bool, String> {
    validate_library_export(&contents)?;
    tauri::async_runtime::spawn_blocking(move || export_library(&app, &contents))
        .await
        .map_err(|error| format!("The library export could not be completed: {error}"))?
}

#[tauri::command]
pub async fn import_library_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || import_library(&app))
        .await
        .map_err(|error| format!("The library import could not be completed: {error}"))?
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        json_file_path, read_library_source, validate_library_export, write_library_export,
    };

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
    fn rejects_duplicate_library_identities() {
        assert!(validate_library_export(
            r#"{"format":"streamsplease-library","version":1,"entries":[{"slug":"a-show"},{"slug":"a-show"}]}"#
        )
        .is_err());
        assert!(validate_library_export(
            r#"{"format":"streamsplease-library","version":1,"entries":[{"slug":"a-show","anilistId":5},{"slug":"b-show","anilistId":5}]}"#
        )
        .is_err());
    }

    #[test]
    fn requires_json_library_file_paths() {
        assert_eq!(
            json_file_path(PathBuf::from("backup"), true).unwrap(),
            PathBuf::from("backup.json")
        );
        assert!(json_file_path(PathBuf::from("backup.JSON"), false).is_ok());
        assert!(json_file_path(PathBuf::from("backup"), false).is_err());
        assert!(json_file_path(PathBuf::from("backup.txt"), true).is_err());
    }

    #[test]
    fn round_trips_library_files_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("library.json");
        write_library_export(&path, "{\"ok\":true}").unwrap();
        assert_eq!(read_library_source(&path).unwrap(), "{\"ok\":true}");
    }
}
