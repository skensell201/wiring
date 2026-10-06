# Wiring — Documentation site and landing page

**Date:** 2026-10-06
**Status:** approved (standing instruction: "after everything, create a landing page for the site with documentation"; recommended options chosen, see §7)

## 1. Goal

Give Wiring a public home: a landing page that says in one screen what Wiring is and lets a visitor download it for their OS, backed by a documentation site that covers installing, every feature, keyboard shortcuts, updates and the developer docs. It is served at its own domain `https://wiringk8s.xyz`, from the same droplet as the user's other sites.

## 2. Non-goals

Analytics, a blog or changelog pages beyond linking GitHub releases, translations, versioned docs, server-side anything, and new screenshots of the user's work clusters.

## 3. Pages

**Landing (`/`).**
- **Hero:** the Wiring mark and name, the one-line pitch "A desktop Kubernetes IDE with a live graph of how your resources connect.", a primary **Download for <OS>** button and a secondary **Read the docs** link. Under them, small links to the other platforms and "All releases".
- **Screenshot:** the graph screenshot (`docs/images/graph.png`) in a framed window.
- **Features grid:** eight cards, each with an icon, a title and two short sentences, and a link to its docs page:
  - Live graph
  - Tables and YAML editing
  - Logs, terminal and port-forward
  - Rollouts and scaling
  - Metrics
  - Several namespaces and RBAC-aware views
  - Custom resources and Helm
  - Automatic updates
- **Get started in three steps:**
  1. Download.
  2. Wiring reads your kubeconfig (or **Add kubeconfig…**).
  3. Pick a cluster and namespace.
- **Footer:** GitHub, Releases, License (MIT), the docs.

**Docs (`/guide/…`).**
- Getting started: install, kubeconfig, login helpers, demo cluster.
- One page per feature group:
  - Graph and navigator
  - Tables and editing
  - Logs, terminal and port-forward
  - Actions
  - Metrics
  - Namespaces and RBAC
  - Custom resources and Helm
  - Empty and error states
- Keyboard shortcuts.
- Updates.

**Developer docs (`/develop/…`):**
- Development and project layout.
- Releasing and code signing.
- IPC contract.

## 4. Content source

The README stays the canonical text. It gains VitePress region markers (`<!-- #region install -->` … `<!-- #endregion install -->`) around its sections. The docs pages pull them in with `<!--@include: ../../README.md#install-->`. `docs/updates.md`, `docs/code-signing.md` and `docs/ipc-contract.md` are included whole. Only the landing copy and short page intros are written for the site. Image paths in included text resolve, because the site copies `docs/images` into its public folder.

## 5. Build and deploy

- **Location:** VitePress (MIT) lives in `site/`, with its own `site/package.json` so the app's dependency tree is untouched. Root scripts `site:dev` and `site:build` delegate to it.
- **Download button:** a small client-side component calls `https://api.github.com/repos/skensell201/wiring/releases/latest` and picks the asset for the visitor's OS:
  - macOS: `.dmg`
  - Windows: the `-setup.exe` (NSIS), else the `.msi`
  - Linux: releases have no Linux build today, so the button reads **Build from source** and links to the Development page.
  - Without JavaScript, or if the API fails, the button links to `/releases/latest`.
- **Theme:** the app's Doppler tokens map onto VitePress's CSS variables, dark only:
  - Midnight Plum `#1c1624` canvas and Shadow Plum `#2d2734` surfaces.
  - Lavender `#b997ff` as the brand and accent colour.
  - Signal Green `#00f575` only for the primary Download button.
  - Bone White and Ash text, and Geist for type.
  - No blue paired with yellow, gold or amber anywhere.
- **Deploy:** the site has its own domain, `https://wiringk8s.xyz`, on the droplet that hosts skensel.com, aftergram.cc and keyorra.com (decision by the user). `base` is `/`. `site/deploy.sh` builds and rsyncs `site/.vitepress/dist/` to `/var/www/wiring/`. nginx gets its own server block with a Let's Encrypt certificate, following the same pattern as the other sites. CI builds and tests the site, but does not deploy it.
- **Link from the README:** the README links to the site at the top.

## 6. Testing

- **Build:** `pnpm site:build` fails on dead links, which VitePress checks by default, and on bad includes. The existing CI workflow runs it.
- **Download picker:** a unit test (Vitest, in `site/`) covers the pure `pickAsset(assets, os)`. It handles macOS and Windows, keeps the NSIS-over-MSI preference, sends Linux to Build from source, and falls back to the releases page when an asset is missing.
- **Visual check:** run `site:dev`, then screenshot the landing and one docs page in a browser. Check that the layout holds on desktop and at a 390 px phone width.

## 7. Decisions log

- **VitePress over a hand-written static page or Astro Starlight:** markdown docs, built-in search, an easy dark theme, and a single small dependency.
- **README regions included into pages:** one source of truth, so the docs cannot drift from the README.
- **OS-detected download via the GitHub releases API:** falls back to the releases page.
- **Hosting at `wiringk8s.xyz` on the user's droplet:** the user chose this over GitHub Pages and over `skensel.com/wiring/`.
