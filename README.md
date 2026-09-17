# Wiring

A desktop Kubernetes IDE whose centerpiece is a live graph of how resources in a namespace are wired together — Ingress → Service → Deployment → Pod, plus ConfigMaps, Secrets, PVCs, ServiceAccounts and HPAs.

Built with Tauri 2, React and Rust (`kube-rs`). macOS and Windows.

## Development

```bash
pnpm install
pnpm tauri dev
```

Backend tests:

```bash
cd src-tauri
cargo test                                   # unit + IPC contract tests
WIRING_SMOKE_CONTEXT=docker-desktop cargo test --test smoke -- --ignored   # needs a running cluster + kubectl
```

## Docs

- Design spec: `docs/superpowers/specs/2026-09-17-wiring-mvp-design.md`
- Backend plan: `docs/superpowers/plans/2026-09-17-wiring-backend.md`
