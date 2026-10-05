//! Self-update: ask the release feed, download and verify the signed package, install, relaunch.
//! The webview only sees these commands; it holds no updater or process permissions.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind};
#[cfg(target_os = "macos")]
use tauri::Runtime;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{AppError, AppResult, ErrorKind};

/// Emit `update_progress` at most every this many bytes (and always for the last chunk).
pub const PROGRESS_STEP: u64 = 256 * 1024;

/// A newer release the feed offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    /// Release day, `YYYY-MM-DD`.
    pub date: Option<String>,
    pub notes: Option<String>,
}

/// The answer to `check_update`: the running version and the offer, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub current: String,
    pub update: Option<UpdateInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// The update found by the last check, installed by `install_update`.
#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<Update>>,
    installing: InstallGuard,
}

impl UpdateState {
    /// Poison-tolerant: a panic elsewhere must not wedge updates.
    fn pending(&self) -> MutexGuard<'_, Option<Update>> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// At most one install at a time; the permit frees the slot when dropped (i.e. on failure).
#[derive(Default)]
pub struct InstallGuard(AtomicBool);

pub struct InstallPermit<'a>(&'a AtomicBool);

impl InstallGuard {
    pub fn try_acquire(&self) -> Option<InstallPermit<'_>> {
        (!self.0.swap(true, Ordering::AcqRel)).then_some(InstallPermit(&self.0))
    }
}

impl Drop for InstallPermit<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Feed problems (offline, no published release with a `latest.json`) are `network`; signature,
/// archive or install failures are `internal`. The plugin's messages carry no secrets.
pub fn update_error(e: &tauri_plugin_updater::Error) -> AppError {
    use tauri_plugin_updater::Error as E;
    let kind = match e {
        E::Reqwest(_) | E::Network(_) | E::ReleaseNotFound => ErrorKind::Network,
        _ => ErrorKind::Internal,
    };
    AppError::new(kind, e.to_string())
}

pub fn progress_due(last_reported: u64, downloaded: u64, total: Option<u64>) -> bool {
    downloaded >= last_reported + PROGRESS_STEP || total.is_some_and(|t| downloaded >= t)
}

fn info(u: &Update) -> UpdateInfo {
    UpdateInfo {
        version: u.version.clone(),
        date: u.date.map(|d| d.date().to_string()),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
    }
}

#[tauri::command]
pub async fn check_update(app: AppHandle, state: State<'_, UpdateState>) -> AppResult<UpdateCheck> {
    let found = app
        .updater()
        .map_err(|e| update_error(&e))?
        .check()
        .await
        .map_err(|e| update_error(&e))?;
    let update = found.as_ref().map(info);
    *state.pending() = found;
    Ok(UpdateCheck {
        current: app.package_info().version.to_string(),
        update,
    })
}

/// Downloads, verifies and installs the update from the last check, reporting `update_progress`,
/// then relaunches into it. Returns only on failure.
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, UpdateState>) -> AppResult<()> {
    let _permit = state
        .installing
        .try_acquire()
        .ok_or_else(|| AppError::new(ErrorKind::Conflict, "an update is already installing"))?;
    let update = state
        .pending()
        .clone()
        .ok_or_else(|| AppError::new(ErrorKind::NotFound, "no update to install; check for updates again"))?;
    let emitter = app.clone();
    let (mut downloaded, mut reported) = (0u64, 0u64);
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                if progress_due(reported, downloaded, total) {
                    reported = downloaded;
                    let _ = emitter.emit("update_progress", UpdateProgress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| update_error(&e))?;
    app.restart()
}

pub const MENU_CHECK_UPDATES: &str = "check-updates";
pub const EVENT_MENU_CHECK: &str = "menu_check_updates";

/// Tauri's default menu plus "Check for Updates…" after About in the app menu. macOS only: Tauri
/// installs a default menu only there, so elsewhere the app keeps having no menu bar.
#[cfg(target_os = "macos")]
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let item = MenuItem::with_id(app, MENU_CHECK_UPDATES, "Check for Updates…", true, None::<&str>)?;
    // On macOS the default menu's first entry is the app submenu (About, services, hide, quit);
    // it has no fixed id, so it is found by position (tauri 2.11 `Menu::default`).
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        app_menu.insert(&item, 1)?;
    }
    Ok(menu)
}

#[cfg(target_os = "macos")]
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id().0 == MENU_CHECK_UPDATES {
        let _ = app.emit(EVENT_MENU_CHECK, ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;

    #[test]
    fn feed_problems_are_network_errors_and_the_rest_internal() {
        assert_eq!(update_error(&tauri_plugin_updater::Error::ReleaseNotFound).kind, ErrorKind::Network);
        assert_eq!(
            update_error(&tauri_plugin_updater::Error::Network("down".into())).kind,
            ErrorKind::Network
        );
        let other = update_error(&tauri_plugin_updater::Error::EmptyEndpoints);
        assert_eq!(other.kind, ErrorKind::Internal);
        assert_eq!(other.message, "Updater does not have any endpoints set.");
    }

    #[test]
    fn progress_is_reported_every_step_and_at_the_end() {
        assert!(!progress_due(0, 1_000, Some(10_000_000)));
        assert!(progress_due(0, PROGRESS_STEP, Some(10_000_000)));
        assert!(!progress_due(PROGRESS_STEP, PROGRESS_STEP + 10, Some(10_000_000)));
        assert!(progress_due(PROGRESS_STEP, 2 * PROGRESS_STEP, None));
        // The last chunk always reports, so the bar reaches 100 %.
        assert!(progress_due(9_999_000, 10_000_000, Some(10_000_000)));
    }

    #[test]
    fn payloads_serialize_in_camel_case() {
        let check = UpdateCheck {
            current: "0.2.0".into(),
            update: Some(UpdateInfo {
                version: "0.3.0".into(),
                date: Some("2026-10-05".into()),
                notes: Some("New".into()),
            }),
        };
        assert_eq!(
            serde_json::to_value(&check).unwrap(),
            serde_json::json!({ "current": "0.2.0", "update": { "version": "0.3.0", "date": "2026-10-05", "notes": "New" } })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress {
                downloaded: 5,
                total: None
            })
            .unwrap(),
            serde_json::json!({ "downloaded": 5, "total": null })
        );
    }

    #[test]
    fn only_one_install_may_run_and_failure_frees_the_slot() {
        let guard = InstallGuard::default();
        let first = guard.try_acquire();
        assert!(first.is_some());
        assert!(guard.try_acquire().is_none());
        drop(first);
        assert!(guard.try_acquire().is_some());
    }

    #[test]
    fn the_menu_item_id_is_stable() {
        // The frontend listens for the event this id triggers; renaming it silently breaks the item.
        assert_eq!(MENU_CHECK_UPDATES, "check-updates");
        assert_eq!(EVENT_MENU_CHECK, "menu_check_updates");
    }
}
