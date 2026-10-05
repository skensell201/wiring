# Automatic updates

Installed copies check `https://github.com/skensell201/wiring/releases/latest/download/latest.json`
10 seconds after launch and every 6 hours (and on **Wiring → Check for Updates…**). That URL only
resolves to the latest **published** release, so a draft is never offered: publishing the draft is
the release gate.

## Signing

Update packages are signed with Wiring's own updater key (minisign, made by
`pnpm tauri signer generate`). This is separate from Apple / Windows code signing.

- Public key: `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. Installed copies accept only
  packages signed by the matching private key.
- Private key and its password: kept in `~/.tauri` on the maintainer's machine and in the
  repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Never
  commit them. Keep an offline copy: if the key is lost, installed copies can no longer be updated
  and users must reinstall by hand.

The release workflow turns on `bundle.createUpdaterArtifacts` only when the key secret is set (it
writes `src-tauri/tauri.updater.conf.json` and passes it with `--config`). Without the secret, such
as on a fork, it warns and builds exactly as before with no update packages. Local builds
(`pnpm tauri build`) need no key and produce no update packages.

## Checking a release

1. Run the workflow by hand (`gh workflow run release.yml`) and check the artifacts contain
   `Wiring.app.tar.gz` + `.sig` (macOS) and `.msi.sig` / `-setup.exe.sig` (Windows). `latest.json`
   appears only for a tagged run.
2. Tag `vX.Y.Z`, review the draft (it has `latest.json`), publish it.
3. An installed earlier version shows **Update X.Y.Z** in the header within 10 s of its next launch.
