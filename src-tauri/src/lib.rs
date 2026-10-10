use tauri::Manager;

mod catalog;
mod library_file;
mod runtime;
mod seeding;
mod torrent;
mod updates;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    runtime::configure_bundled_media_tools();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let torrent_state = torrent::TorrentState::new(app.handle())
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
            runtime::runtime_info,
            updates::check_for_update,
            updates::install_update,
            torrent::add_magnet,
            torrent::torrent_status,
            torrent::stream_url,
            torrent::release_torrent,
            torrent::transfer_speeds,
            seeding::seeding_overview,
            seeding::set_seeding_target_ratio,
            seeding::set_seeding_upload_limit,
            seeding::remove_torrent,
            library_file::export_library_file,
            library_file::import_library_file,
            catalog::catalog_providers,
            catalog::catalog_request,
            catalog::subsplease::subsplease_schedule,
            catalog::subsplease::subsplease_index,
            catalog::subsplease::subsplease_show,
        ])
        .run(tauri::generate_context!())
        .expect("error while running StreamsPlease");
}
