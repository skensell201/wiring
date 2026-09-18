pub mod commands;
pub mod error;
pub mod graph;
pub mod kubeconfig;
pub mod manifest;
pub mod session;
pub mod store;

pub fn run() {
    let default_filter = if cfg!(debug_assertions) { "info,wiring_lib=debug" } else { "info" };
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| default_filter.into()))
        .init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init());

    commands::register(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
