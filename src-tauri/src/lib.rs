pub mod commands;
pub mod discovery;
pub mod error;
pub mod exec;
pub mod forward;
pub mod graph;
pub mod kubeconfig;
pub mod logs;
pub mod manifest;
pub mod metrics;
pub mod session;
pub mod store;
pub mod updates;

pub fn run() {
    let default_filter = if cfg!(debug_assertions) { "info,wiring_lib=debug" } else { "info" };
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| default_filter.into()))
        .init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    // Tauri installs a default menu only on macOS; elsewhere the app has no menu bar, so none is set.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(updates::build_menu).on_menu_event(updates::on_menu_event);

    commands::register(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
