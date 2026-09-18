# Wiring

A desktop Kubernetes IDE whose centerpiece is a live graph of how resources in a namespace are wired together — Ingress → Service → Deployment → Pod, plus ConfigMaps, Secrets, PVCs, ServiceAccounts and HPAs.

Built with Tauri 2, React and Rust (`kube-rs`). macOS and Windows.

## Development

Prerequisites: Rust stable, Node 22, pnpm 9, and a kubeconfig with at least one context.

```bash
pnpm install
pnpm tauri dev          # app with hot reload
pnpm test               # frontend unit tests (Vitest)
pnpm typecheck
cd src-tauri && cargo test                                   # backend unit + IPC contract tests
WIRING_SMOKE_CONTEXT=docker-desktop cargo test --test smoke -- --ignored   # needs a live cluster + kubectl
```

## Releases

Tagging `v*` builds unsigned installers for macOS (universal `.dmg`) and Windows (`.msi`, `.exe`) via GitHub Actions and attaches them to a draft release. macOS: `xattr -d com.apple.quarantine Wiring.app` after download. Windows: SmartScreen → *More info* → *Run anyway*.

## Navigator and tables

The left Navigator lists your kubeconfig contexts and the resources of the selected namespace by category (Workloads, Config, Network, Storage, Access Control) with live counts and worst-status dots. Clicking a kind opens a `kubectl get`-style table (sortable, filtered by the search box); a row click shows details, a double-click (or Enter) jumps to the object in the graph. Kinds you cannot read are struck through. The sidebar collapses to an icon rail.

## Demo cluster

`examples/demo/setup.sh [context]` (default `docker-desktop`) deploys the `shop` and `blog` namespaces, the `wiring-viewer` / `wiring-auditor` RBAC identities, and adds matching restricted kubeconfig contexts so you can see filters and denied-kind handling against a real cluster. See `examples/demo/*.yaml` for the workload and RBAC definitions.

```bash
examples/demo/setup.sh kind-kind
```

## Docs

- Design spec: `docs/superpowers/specs/2026-09-17-wiring-mvp-design.md`
- Backend plan: `docs/superpowers/plans/2026-09-17-wiring-backend.md`
- Frontend plan: `docs/superpowers/plans/2026-09-17-wiring-frontend.md`
- IPC contract: `docs/ipc-contract.md`
