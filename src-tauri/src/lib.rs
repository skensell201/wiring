pub mod commands;
pub mod error;
pub mod graph;
pub mod kubeconfig;
pub mod session;
pub mod store;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,wiring_lib=debug".into()))
        .init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init());

    commands::register(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
