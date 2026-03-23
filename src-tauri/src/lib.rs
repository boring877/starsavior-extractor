mod commands;

use commands::state::ActiveProcess;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ActiveProcess(std::sync::Arc::new(std::sync::Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![
            commands::extract::app_get_defaults,
            commands::extract::list_templets,
            commands::extract::run_decrypt_bundles,
            commands::extract::run_decrypt_templets,
            commands::extract::run_extract_images,
            commands::extract::process_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
