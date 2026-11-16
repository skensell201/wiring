# The branded Windows installer

Tauri's default NSIS installer is a grey Windows wizard. This directory holds the
replacement: a custom `.nsi` template that repaints the wizard in the app's own
palette (Midnight Plum, Bone White, Lavender Spark, Signal Green), plus the
bitmaps and the flat-mark icon it needs.

Direction A of `docs/superpowers/specs/2026-11-16-installer-mockup.html` is the
reference: the classic wizard, every surface repainted, no new binary.

## Files

| File | What it is |
| --- | --- |
| `wiring-installer.nsi` | The NSIS template. Tauri's own template with the install logic untouched and the UI restyled. |
| `wiring-header.bmp` | 150x57 header strip: plum ground, the heptagon mark, the "Wiring" wordmark. Shown at the top of every page. |
| `wiring-welcome.bmp` | 164x314 welcome/finish bitmap: plum ground, the heptagon mark, the wordmark. Shown on the first and the last page. |
| `wiring-btn-next.bmp`, `wiring-btn-finish.bmp` | 88x26 Signal Green artwork for the one primary action ("Next >" / "Finish"). |
| `*.png` | The design sources for the bitmaps above. |
| `generate-assets.py` | Renders every bitmap from `src/assets/mark.svg` and the app's tokens, and packs `src-tauri/icons/icon-flat.ico`. |

`src-tauri/icons/icon-flat.ico` is the flat mark at 16, 24, 32, 48, 64 and 256 px
(PNG payloads inside a plain ICO container). It is what the installer and the
uninstaller show in Explorer's Downloads list and in Add/Remove Programs. The
macOS-style plate (`icons/icon.ico`) is still the *application* icon and is left
alone in `bundle.icon`.

## Colours: NSIS is BGR, not RGB

NSIS colours are `COLORREF`s: `0x00BBGGRR`. Every colour in the template is
already converted, so **do not "fix" them back to RGB**:

| Token | Hex | NSIS (BGR) |
| --- | --- | --- |
| Midnight Plum (canvas) | `#1c1624` | `24161C` |
| Shadow Plum (cards) | `#2d2734` | `34272D` |
| Elevated | `#3a3340` | `40333A` |
| Iron Edge | `#55505b` | `5B5055` |
| Bone White | `#f1f0ec` | `ECF0F1` |
| Ash Veil | `#d0c9c4` | `C4C9D0` |
| Mid Ash | `#a5a2a5` | `A5A2A5` |
| Lavender Spark | `#b997ff` | `FF97B9` |
| Signal Green | `#00f575` | `75F500` |

The one exception is `MUI_INSTFILESPAGE_COLORS`, which feeds NSIS's
`InstallColors`. That command documents its colours as **RRGGBB** (see the NSIS
manual, *InstallColors*), so that single value is written the other way round.

## The pages

Tauri v2 has no NSIS components page, so the flow is the one the Tauri template
defines:

```
Welcome -> Install directory -> Start menu -> Install -> Finish
```

The reinstall page (only when a previous install is found) and the uninstall
pages keep MUI2's stock look, apart from the branded header strip.

## What MUI2 can and cannot repaint

Win32 controls cannot be pixel-perfect, so the template works with the
facilities MUI2 actually exposes:

* `MUI_BGCOLOR` / `MUI_TEXTCOLOR` paint the header strip and the welcome and
  finish pages (those pages are full-window pages, so they carry the mark in
  `wiring-welcome.bmp` instead of the header strip).
* `MUI_HEADERIMAGE_BITMAP` (150x57) carries the mark and the wordmark on every
  other page.
* `MUI_DIRECTORYPAGE_BGCOLOR` and `MUI_STARTMENUPAGE_BGCOLOR` turn the path
  fields into Shadow Plum cards with Bone White text.
* `MUI_INSTFILESPAGE_COLORS` paints the install progress panel Bone White on
  Midnight Plum.
* `SetCtlColors` repaints the static and edit controls of a page (the welcome
  and finish descriptions become Ash Veil).
* The one primary action is *drawn*, not themed: the caption is baked into a
  Signal Green bitmap and pushed into the native button with `BM_SETIMAGE`.

What stays native, and why: the page background of the directory and start-menu
pages (MUI2 draws those from a dialog resource), the tree views, the check
boxes' label colour, the progress bar and the tree-view selection colour.
NSIS's `SetCtlColors` only handles `WM_CTLCOLORSTATIC`/`WM_CTLCOLOREDIT`, and
MUI2 has no hook for the dialog background, so those surfaces keep the system
look.

If the green button does not look right on your machine, comment out the
`MUI_PAGE_CUSTOMFUNCTION_SHOW` lines in `wiring-installer.nsi` (or the
`WiringPaintPrimary` call inside `WiringStyleNext` / `WiringStyleFinish`): the
installer then keeps the native navigation buttons and still builds.

## Rebuilding the assets

```sh
python3 src-tauri/windows/generate-assets.py
```

Needs Google Chrome (headless) and `sips` (macOS). It rewrites the PNGs, the
BMPs and `src-tauri/icons/icon-flat.ico`.

NSIS cannot load PNG branding images, and it rejects top-down bitmaps
(`!pragma verifyloadimage` only accepts `BITMAPCOREHEADER`/`BITMAPINFOHEADER`
bitmaps with a positive height), so every bitmap is also written as a
bottom-up 24-bit Windows bitmap. The script does that conversion.

## Building the installer

NSIS installers are produced on Windows. On a Windows machine with the usual
Tauri prerequisites (Rust, Node, pnpm, Visual Studio build tools):

```sh
pnpm install --frozen-lockfile
pnpm tauri build --bundles nsis
```

The installer lands in:

```
src-tauri/target/release/bundle/nsis/Wiring_<version>_x64-setup.exe
```

CI does the same thing in the `installer` job of `.github/workflows/ci.yml` and
uploads the `.exe` as the `wiring-installer-windows` artifact, so the installer
can be downloaded from a workflow run without a local Windows box.

## Testing it on Windows

1. Download the `.exe` and run it.
2. **Welcome** - the page is Midnight Plum with the heptagon mark and the
   "Wiring" wordmark; the primary action is Signal Green.
3. **Install directory** - the header strip carries the mark and the wordmark;
   the path field is a Shadow Plum card. Check that the tree view and the
   Browse button still work.
4. **Start menu** - same treatment for the folder field.
5. **Install** - the progress panel is Bone White on Midnight Plum. Leave the
   details pane open to check the text contrast.
6. **Finish** - plum page, the mark, and a Signal Green "Finish" button. Tick
   "Show Readme" to create the desktop shortcut, and let it launch the app.
7. **Uninstall** - Settings > Apps > Installed apps > Wiring > Uninstall. The
   uninstaller carries the same header strip; the "Delete app data" check box
   is stock MUI2.

To check the icon: put the `.exe` in a folder, open Explorer's Downloads list
and the Add/Remove Programs entry - both must show the flat violet heptagon
mark, not the macOS-style plate. The flat mark is legible down to 16 px; the
plate turned to mush there.

To check the green button at other display scalings: 100% is the design size.
At 125% and above the artwork keeps its pixel size and is centred in the
(native, larger) button, because the bitmap is not DPI-scaled.

## Linux

`bundle.linux.deb` and `bundle.linux.appimage` have no icon setting: Tauri
writes the `.desktop` entry with `Icon=<app name>` and copies the **PNG** files
from `bundle.icon` into `/usr/share/icons/hicolor/<size>x<size>/apps/`. So the
PNG files decide what Linux shows — in the launcher and in the desktop entry.

They are the flat mark: `generate-assets.py` renders `32x32.png`,
`128x128.png`, `128x128@2x.png` and `icon.png` from `src/assets/mark.svg`, the
same mark the installer shows. The plate stays in `icon.icns` (macOS) and
`icon.ico` (the Windows *application* icon), where the rounded ground still
reads at a glance; the installer itself uses `icon-flat.ico`.

The app's own first run carries the brand on Linux instead: there is no system
installer to do it.

## What was verified locally, and what was not

Verified on macOS:

* the template renders through Tauri's handlebars context and compiles cleanly
  with NSIS 3.13 (`makensis`), both with and without the primary-action
  artwork;
* every bitmap exists at the exact size MUI2 expects (150x57, 164x314) and is
  accepted by `!pragma verifyloadimage`;
* `src-tauri/icons/icon-flat.ico` lists the six sizes 16, 24, 32, 48, 64, 256;
* `pnpm tauri info` exits 0 with the new configuration, and the macOS bundle
  still builds.

**Not** verified: the actual appearance. Windows-only behaviour (the exact
button rendering, the DPI behaviour, the focus rings) needs a real Windows
machine - that is what the CI artifact is for.
