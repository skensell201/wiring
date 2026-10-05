# Wiring — Automatic updates

**Date:** 2026-10-05
**Status:** approved
**Builds on:** the release workflow (`.github/workflows/release.yml`, tauri-action, draft releases) and every feature branch up to `feat/metrics`.

## 1. Goal

Installed copies find, download and install new releases themselves, so users stay current without visiting GitHub. Updates are signed with Wiring's own updater key and only offered once a release is published (drafts stay invisible), so the existing review-the-draft step remains the gate.

## 2. Non-goals

Delta updates, release channels (beta), forced updates, background installs without a click, update checks for Linux builds, changes to Apple/Windows code signing.

## 3. User flows

- **Check.** 10 s after launch and then every 6 hours the app asks the update endpoint. Network errors and "no update" are silent.
- **Offer.** When a newer version exists, the header shows an accent pill **Update 0.3.0**. Clicking it opens a dialog: version, release date, release notes (plain text, scrollable), **Install and restart** and **Later**. *Later* hides the pill until the next launch.
- **Install.** *Install and restart* downloads with a progress bar (`12.3 / 45.6 MB`), verifies the signature, installs and relaunches. A failure shows the error inline in the dialog with **Retry**; the app keeps running.
- **Manual check.** **Wiring → Check for Updates…** in the app menu (on Windows the same item under **Help**) runs a check now: an update opens the same dialog, otherwise a toast *Wiring 0.2.0 is up to date*, an error shows a toast with the message.
- **Dev builds.** `pnpm tauri dev` and local builds without the signing key never check (the check is compiled in but skipped when the app runs from a dev build), so development is not interrupted.

## 4. Backend

- `tauri-plugin-updater` and `tauri-plugin-process` (relaunch) are added and initialised in `lib.rs`.
- `tauri.conf.json` → `plugins.updater`: `pubkey` = the contents of `~/.tauri/wiring-updater.key.pub` (generated for this project; the private key and its password are stored as the GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), `endpoints` = `["https://github.com/skensell201/wiring/releases/latest/download/latest.json"]`. On Windows `installMode: "passive"`.
- `bundle.createUpdaterArtifacts` is **not** set in the committed config (local builds have no key); the release workflow passes it with `--config '{"bundle":{"createUpdaterArtifacts":true}}'` and exposes the two secrets as env vars to tauri-action, which then uploads the `.app.tar.gz` / installer signatures and `latest.json` to the draft release.
- Commands (Rust-side, so the webview needs no updater/process capabilities):
  - `check_update` → `UpdateInfo { version, date, notes } | null`; errors are `AppError` (`unavailable` for network/endpoint problems).
  - `install_update` → downloads and installs the update found by the last check, emitting `update_progress { downloaded, total | null }`, then relaunches; errors are returned.
- App menu: the default menu plus **Check for Updates…** (Wiring menu on macOS, Help on Windows), emitting `menu_check_updates` to the frontend.
- The periodic check lives in the frontend (timer), so it is trivially paused in tests and dev.

## 5. Frontend

- `src/features/update/`: `useUpdateChecker` (10 s after start, then 6 h; skipped when `import.meta.env.DEV`), `UpdatePill` in the header, `UpdateDialog` (notes, progress, error + Retry), store slice `update { available, dismissed, dialogOpen, progress, error }`.
- `menu_check_updates` triggers a manual check with the toasts above.

## 6. Testing

- **Rust:** config round-trip test that the updater pubkey and endpoint are present and the endpoint is the GitHub `latest/download/latest.json` URL; command error mapping (pure fn).
- **Vitest:** checker timing (fake timers: first check at 10 s, then every 6 h, none in DEV), pill shown/hidden/dismissed, dialog flows (install progress, error + retry, Later), manual-check toasts.
- **Release workflow:** a manual `workflow_dispatch` run builds with the key and must produce `*.app.tar.gz.sig` / `*.msi.sig` / `*-setup.exe.sig` artifacts (documented check; run by the maintainer).
- **End to end (maintainer):** publish 0.3.0 with updater artifacts; an installed 0.3.0 then sees 0.3.1 once that is published.

## 7. Decisions log

- Signed with a Tauri updater key generated for Wiring; private key + password live only in `~/.tauri/` and GitHub secrets.
- Endpoint is the latest *published* GitHub release, so drafts are never offered.
- Check at launch + every 6 h; offer via a header pill and a dialog; install on click, then relaunch.
- Update commands run in Rust; no updater/process permissions for the webview.
- Updater artifacts are only created in the release workflow, never by local builds.
