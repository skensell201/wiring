//! Tauri command layer: thin wrappers over kubeconfig + Session.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Emitter as TauriEmit, State};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::graph::rows::Table;
use crate::graph::NodeId;
use crate::kubeconfig::{self, ContextInfo};
use crate::logs::session::LogRequest;
use crate::logs::LogMessage;
use crate::session::emitter::{Emitter, OutEvent};
use crate::session::{ConnectInfo, ObjectDetails, Session};
use crate::store::Kind;

const SETTINGS_FILE: &str = "settings.json";
const KEY_EXTRA_KUBECONFIGS: &str = "extraKubeconfigs";

pub struct TauriEmitter(pub AppHandle);

impl Emitter for TauriEmitter {
    fn emit(&self, event: OutEvent) {
        let (name, payload) = event.into_parts();
        if let Err(e) = self.0.emit(name, payload) {
            tracing::warn!(event = name, error = %e, "failed to emit");
        }
    }
}

#[derive(Default)]
pub struct AppState {
    pub session: Mutex<Option<Session>>,
}

fn extra_kubeconfigs(app: &AppHandle) -> Vec<PathBuf> {
    app.store(SETTINGS_FILE)
        .ok()
        .and_then(|s| s.get(KEY_EXTRA_KUBECONFIGS))
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect()
}

fn all_kubeconfig_paths(app: &AppHandle) -> Vec<PathBuf> {
    let mut paths = kubeconfig::default_paths();
    paths.extend(extra_kubeconfigs(app));
    paths
}

#[tauri::command]
pub fn list_contexts(app: AppHandle) -> AppResult<Vec<ContextInfo>> {
    kubeconfig::list_contexts(&all_kubeconfig_paths(&app))
}

#[tauri::command]
pub fn add_kubeconfig(app: AppHandle, path: String) -> AppResult<Vec<ContextInfo>> {
    let p = PathBuf::from(&path);
    kubeconfig::validate_file(&p)?;
    let mut extra = extra_kubeconfigs(&app);
    if !extra.contains(&p) {
        extra.push(p);
    }
    let store = app.store(SETTINGS_FILE).map_err(|e| AppError::internal(e.to_string()))?;
    store.set(KEY_EXTRA_KUBECONFIGS, json!(kubeconfig::path_strings(&extra)));
    store.save().map_err(|e| AppError::internal(e.to_string()))?;
    list_contexts(app)
}

#[tauri::command]
pub async fn connect(app: AppHandle, state: State<'_, AppState>, context: String) -> AppResult<ConnectInfo> {
    let merged = kubeconfig::load_merged(&all_kubeconfig_paths(&app))?;
    let emitter: Arc<dyn Emitter> = Arc::new(TauriEmitter(app.clone()));
    // Hold the lock for the whole operation, including the network round-trips: the old
    // session must be gone (its `Disconnected` emitted) before the new one announces
    // `Connected`, otherwise the frontend's last state is `disconnected`. Other commands
    // would only hit a torn-down session in the meantime anyway.
    let mut guard = state.session.lock().await;
    if let Some(mut old) = guard.take() {
        old.shutdown();
    }
    let (session, info) = Session::connect(merged, &context, emitter).await?;
    let session = guard.insert(session);
    session.announce_connected();
    Ok(info)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> AppResult<()> {
    let mut guard = state.session.lock().await;
    if let Some(mut s) = guard.take() {
        drop(guard);
        s.shutdown();
    }
    Ok(())
}

/// Borrow the active session out of the state guard, or `Internal` if not connected.
fn session_mut(guard: &mut Option<Session>) -> AppResult<&mut Session> {
    guard.as_mut().ok_or_else(|| AppError::new(ErrorKind::Internal, "not connected"))
}

#[tauri::command]
pub async fn select_namespace(state: State<'_, AppState>, namespace: String, expanded_groups: Vec<String>) -> AppResult<()> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session
        .select_namespace(&namespace, expanded_groups.into_iter().collect::<HashSet<_>>())
        .await
}

#[tauri::command]
pub async fn set_expanded_groups(state: State<'_, AppState>, expanded_groups: Vec<String>) -> AppResult<()> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session
        .set_expanded_groups(expanded_groups.into_iter().collect::<HashSet<_>>())
        .await
}

#[tauri::command]
pub async fn get_object(state: State<'_, AppState>, node_id: String) -> AppResult<ObjectDetails> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.get_object(&node_id)
}

#[tauri::command]
pub async fn watch_events(state: State<'_, AppState>, node_id: Option<String>) -> AppResult<()> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.watch_events(node_id.as_deref()).await
}

#[tauri::command]
pub async fn denied_kinds(state: State<'_, AppState>) -> AppResult<Vec<Kind>> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    Ok(session.denied_kinds())
}

#[tauri::command]
pub async fn list_rows(state: State<'_, AppState>, kind: Kind) -> AppResult<Table> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    Ok(session.list_rows(kind))
}

#[tauri::command]
pub async fn update_object(state: State<'_, AppState>, node_id: String, yaml: String, force: bool) -> AppResult<ObjectDetails> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.update_object(&node_id, &yaml, force).await
}

#[tauri::command]
pub async fn create_object(state: State<'_, AppState>, namespace: String, yaml: String) -> AppResult<NodeId> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.create_object(&namespace, &yaml).await
}

#[tauri::command]
pub async fn delete_object(state: State<'_, AppState>, node_id: String) -> AppResult<()> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.delete_object(&node_id).await
}

/// Stream container logs for `node_id` into `on_message`; returns the id for `stop_logs`.
#[tauri::command]
pub async fn start_logs(
    state: State<'_, AppState>,
    node_id: String,
    container: Option<String>,
    previous: bool,
    timestamps: bool,
    on_message: tauri::ipc::Channel<LogMessage>,
) -> AppResult<u32> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.start_logs(
        LogRequest {
            node_id,
            container,
            previous,
            timestamps,
        },
        Arc::new(on_message),
    )
}

/// Stop a log session; unknown ids and a missing session are no-ops (the streams are gone).
#[tauri::command]
pub async fn stop_logs(state: State<'_, AppState>, session_id: u32) -> AppResult<()> {
    let mut guard = state.session.lock().await;
    if let Some(session) = guard.as_mut() {
        session.stop_logs(session_id);
    }
    Ok(())
}

/// Write text the user chose a destination for (the save dialog picked `path`).
#[tauri::command]
pub async fn save_text(path: String, text: String) -> AppResult<()> {
    tokio::fs::write(&path, text)
        .await
        .map_err(|e| AppError::internal(format!("{path}: {e}")))
}

pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.manage(AppState::default()).invoke_handler(tauri::generate_handler![
        list_contexts,
        add_kubeconfig,
        connect,
        disconnect,
        select_namespace,
        set_expanded_groups,
        get_object,
        watch_events,
        denied_kinds,
        list_rows,
        update_object,
        create_object,
        delete_object,
        start_logs,
        stop_logs,
        save_text,
    ])
}
