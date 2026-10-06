//! Tauri command layer: thin wrappers over kubeconfig + Session.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Emitter as TauriEmit, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

use crate::custom::id::CustomId;
use crate::custom::{ops, CustomTable};
use crate::discovery::{self, CustomKind, ResourceRef};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::exec::session::ExecRequest;
use crate::exec::{clamp_size, decode_input, ExecMessage, ExecPod};
use crate::forward::{Forward, PortOption};
use crate::graph::rows::Table;
use crate::graph::NodeId;
use crate::helm::{HelmRelease, HelmReleaseDetails};
use crate::kubeconfig::{self, ContextInfo};
use crate::logs::session::LogRequest;
use crate::logs::LogMessage;
use crate::manifest;
use crate::session::emitter::{Emitter, OutEvent};
use crate::session::rollout::Revision;
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
        old.shutdown().await;
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
        s.shutdown().await;
    }
    Ok(())
}

/// Borrow the active session out of the state guard, or `Internal` if not connected.
fn session_mut(guard: &mut Option<Session>) -> AppResult<&mut Session> {
    guard.as_mut().ok_or_else(|| AppError::new(ErrorKind::Internal, "not connected"))
}

/// `namespaces: null` watches all namespaces; a list watches those.
#[tauri::command]
pub async fn select_namespaces(state: State<'_, AppState>, namespaces: Option<Vec<String>>, expanded_groups: Vec<String>) -> AppResult<()> {
    let scope = crate::session::scope::NamespaceScope::from_arg(namespaces)?;
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session
        .select_scope(scope, expanded_groups.into_iter().collect::<HashSet<_>>())
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

/// The session's client and generation, taken under the lock and released right away so the
/// requests that follow never hold it.
async fn client_of(state: &AppState) -> AppResult<(kube::Client, u64)> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    Ok((session.client_handle(), session.generation()))
}

/// Discovery results, from the session's cache unless `refresh`; discovery runs without the
/// lock and is only cached into the session that started it.
async fn custom_kinds_cached(state: &AppState, refresh: bool) -> AppResult<Vec<CustomKind>> {
    let (client, generation) = {
        let mut guard = state.session.lock().await;
        let session = session_mut(&mut guard)?;
        if !refresh {
            if let Some(kinds) = session.custom_kinds() {
                return Ok(kinds.to_vec());
            }
        }
        (session.client_handle(), session.generation())
    };
    let kinds = discovery::discover(client).await?;
    let mut guard = state.session.lock().await;
    if let Some(session) = guard.as_mut().filter(|s| s.generation() == generation) {
        session.set_custom_kinds(kinds.clone());
    }
    Ok(kinds)
}

async fn resolve_kind(state: &AppState, group: &str, version: &str, kind: &str) -> AppResult<CustomKind> {
    let kinds = custom_kinds_cached(state, false).await?;
    discovery::find_kind(&kinds, group, version, kind).ok_or_else(|| {
        AppError::new(
            ErrorKind::NotFound,
            format!("{kind} ({group}) is not served by this cluster or cannot be listed"),
        )
    })
}

/// Graph neighbours of `node_id`, for a custom resource's details.
async fn related_of(state: &AppState, generation: u64, node_id: &str) -> Vec<NodeId> {
    let guard = state.session.lock().await;
    guard
        .as_ref()
        .filter(|s| s.generation() == generation)
        .map(|s| s.related(node_id))
        .unwrap_or_default()
}

#[tauri::command]
pub async fn custom_kinds(state: State<'_, AppState>) -> AppResult<Vec<CustomKind>> {
    custom_kinds_cached(&state, false).await
}

#[tauri::command]
pub async fn refresh_custom_kinds(state: State<'_, AppState>) -> AppResult<Vec<CustomKind>> {
    custom_kinds_cached(&state, true).await
}

/// The rows of `resource` in the current scope; the table then stays live through
/// `custom_table` events until `stop_custom`, another `list_custom` or a scope switch.
#[tauri::command]
pub async fn list_custom(state: State<'_, AppState>, resource: ResourceRef) -> AppResult<CustomTable> {
    crate::session::custom::list_custom(&state.session, || {
        resolve_kind(&state, &resource.group, &resource.version, &resource.kind)
    })
    .await
}

#[tauri::command]
pub async fn stop_custom(state: State<'_, AppState>) -> AppResult<()> {
    let mut guard = state.session.lock().await;
    if let Some(session) = guard.as_mut() {
        session.stop_custom();
    }
    Ok(())
}

/// The store handle, taken under the session lock and released before the (possibly large)
/// Helm records are decoded, so other commands are not blocked meanwhile.
async fn shared_of(state: &AppState) -> AppResult<crate::session::shared::Shared> {
    let mut guard = state.session.lock().await;
    Ok(session_mut(&mut guard)?.shared_handle())
}

#[tauri::command]
pub async fn helm_releases(state: State<'_, AppState>) -> AppResult<Vec<HelmRelease>> {
    Ok(shared_of(&state).await?.helm_releases())
}

#[tauri::command]
pub async fn helm_release(state: State<'_, AppState>, namespace: String, name: String) -> AppResult<HelmReleaseDetails> {
    shared_of(&state).await?.helm_release(&namespace, &name)
}

#[tauri::command]
pub async fn get_object(state: State<'_, AppState>, node_id: String) -> AppResult<ObjectDetails> {
    if let Some(id) = CustomId::of(&node_id)? {
        let kind = resolve_kind(&state, &id.group, &id.version, &id.kind).await?;
        let (client, generation) = client_of(&state).await?;
        let mut details = ops::get(&client, &kind, &id).await?;
        details.related = related_of(&state, generation, &node_id).await;
        return Ok(details);
    }
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
pub async fn partial_kinds(state: State<'_, AppState>) -> AppResult<Vec<Kind>> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    Ok(session.partial_kinds())
}

#[tauri::command]
pub async fn list_rows(state: State<'_, AppState>, kind: Kind, include_helm_storage: Option<bool>) -> AppResult<Table> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    Ok(session.list_rows(kind, include_helm_storage.unwrap_or(false)))
}

#[tauri::command]
pub async fn update_object(state: State<'_, AppState>, node_id: String, yaml: String, force: bool) -> AppResult<ObjectDetails> {
    if let Some(id) = CustomId::of(&node_id)? {
        let kind = resolve_kind(&state, &id.group, &id.version, &id.kind).await?;
        let (client, generation) = client_of(&state).await?;
        let mut details = ops::update(&client, &kind, &id, &yaml, force).await?;
        details.related = related_of(&state, generation, &node_id).await;
        return Ok(details);
    }
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.update_object(&node_id, &yaml, force).await
}

#[tauri::command]
pub async fn create_object(state: State<'_, AppState>, namespace: String, yaml: String) -> AppResult<NodeId> {
    let raw = manifest::parse_raw(&yaml)?;
    if Kind::parse(&raw.kind).is_none() {
        let (group, version) = ops::manifest_group_version(&raw).map(|(g, v)| (g.to_owned(), v.to_owned()))?;
        let kind = resolve_kind(&state, &group, &version, &raw.kind).await?;
        let (client, _) = client_of(&state).await?;
        return ops::create(&client, &kind, raw, &namespace).await;
    }
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.create_object(&namespace, &yaml).await
}

#[tauri::command]
pub async fn delete_object(state: State<'_, AppState>, node_id: String) -> AppResult<()> {
    if let Some(id) = CustomId::of(&node_id)? {
        let kind = resolve_kind(&state, &id.group, &id.version, &id.kind).await?;
        let (client, _) = client_of(&state).await?;
        return ops::delete(&client, &kind, &id).await;
    }
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.delete_object(&node_id).await
}

#[tauri::command]
pub async fn scale_object(state: State<'_, AppState>, node_id: String, replicas: i64) -> AppResult<ObjectDetails> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.scale_object(&node_id, replicas).await
}

#[tauri::command]
pub async fn restart_object(state: State<'_, AppState>, node_id: String) -> AppResult<ObjectDetails> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.restart_object(&node_id).await
}

#[tauri::command]
pub async fn rollout_history(state: State<'_, AppState>, node_id: String) -> AppResult<Vec<Revision>> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.rollout_history(&node_id).await
}

#[tauri::command]
pub async fn rollback_object(state: State<'_, AppState>, node_id: String, revision: i64) -> AppResult<ObjectDetails> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.rollback_object(&node_id, revision).await
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

#[tauri::command]
pub async fn exec_pods(state: State<'_, AppState>, node_id: String) -> AppResult<Vec<ExecPod>> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.exec_pods(&node_id)
}

/// Open a terminal in `pod`/`container` of `node_id`; output and the end arrive on `on_message`.
#[tauri::command]
pub async fn start_exec(
    state: State<'_, AppState>,
    node_id: String,
    pod: String,
    container: String,
    cols: u16,
    rows: u16,
    on_message: tauri::ipc::Channel<ExecMessage>,
) -> AppResult<u32> {
    let (cols, rows) = clamp_size(cols, rows);
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.start_exec(
        ExecRequest {
            node_id,
            pod,
            container,
            cols,
            rows,
        },
        Arc::new(on_message),
    )
}

/// Keystrokes (base64). Unknown sessions and a missing connection are no-ops.
#[tauri::command]
pub async fn exec_input(state: State<'_, AppState>, session_id: u32, data: String) -> AppResult<()> {
    let bytes = decode_input(&data)?;
    let guard = state.session.lock().await;
    if let Some(session) = guard.as_ref() {
        session.exec_input(session_id, bytes);
    }
    Ok(())
}

#[tauri::command]
pub async fn exec_resize(state: State<'_, AppState>, session_id: u32, cols: u16, rows: u16) -> AppResult<()> {
    let (cols, rows) = clamp_size(cols, rows);
    let guard = state.session.lock().await;
    if let Some(session) = guard.as_ref() {
        session.exec_resize(session_id, cols, rows);
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_exec(state: State<'_, AppState>, session_id: u32) -> AppResult<()> {
    let mut guard = state.session.lock().await;
    if let Some(session) = guard.as_mut() {
        session.stop_exec(session_id).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn forward_ports(state: State<'_, AppState>, node_id: String) -> AppResult<Vec<PortOption>> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.forward_ports(&node_id)
}

#[tauri::command]
pub fn suggest_local_port(port: u16) -> u16 {
    crate::forward::resolve::suggest_local_port(port)
}

#[tauri::command]
pub async fn start_forward(state: State<'_, AppState>, node_id: String, remote_port: u16, local_port: u16) -> AppResult<Forward> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.start_forward(&node_id, remote_port, local_port).await
}

/// Unknown ids and a missing session are no-ops (the forward is gone either way).
#[tauri::command]
pub async fn stop_forward(state: State<'_, AppState>, id: u32) -> AppResult<()> {
    let mut guard = state.session.lock().await;
    if let Some(session) = guard.as_mut() {
        session.stop_forward(id).await;
    }
    Ok(())
}

/// Open `http://127.0.0.1:<port>` of forward `id` in the default browser. The URL is built here
/// from the forward's own port, so the webview cannot open arbitrary URLs through this.
#[tauri::command]
pub async fn open_forward(app: AppHandle, state: State<'_, AppState>, id: u32) -> AppResult<()> {
    let port = {
        let guard = state.session.lock().await;
        guard.as_ref().and_then(|s| s.forward_local_port(id))
    }
    .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("no forward {id}")))?;
    app.opener()
        .open_url(format!("http://127.0.0.1:{port}"), None::<&str>)
        .map_err(|e| AppError::internal(e.to_string()))
}

/// Write text the user chose a destination for (the save dialog picked `path`).
#[tauri::command]
pub async fn save_text(path: String, text: String) -> AppResult<()> {
    tokio::fs::write(&path, text)
        .await
        .map_err(|e| AppError::internal(format!("{path}: {e}")))
}

pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .manage(AppState::default())
        .manage(crate::updates::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            list_contexts,
            add_kubeconfig,
            connect,
            disconnect,
            select_namespaces,
            set_expanded_groups,
            get_object,
            watch_events,
            denied_kinds,
            partial_kinds,
            list_rows,
            custom_kinds,
            refresh_custom_kinds,
            list_custom,
            stop_custom,
            helm_releases,
            helm_release,
            update_object,
            create_object,
            delete_object,
            scale_object,
            restart_object,
            rollout_history,
            rollback_object,
            start_logs,
            stop_logs,
            exec_pods,
            start_exec,
            exec_input,
            exec_resize,
            stop_exec,
            forward_ports,
            suggest_local_port,
            start_forward,
            stop_forward,
            open_forward,
            save_text,
            crate::updates::check_update,
            crate::updates::install_update,
        ])
}
