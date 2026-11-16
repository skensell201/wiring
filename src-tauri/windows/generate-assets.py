#!/usr/bin/env python3
"""Render the Wiring installer bitmaps and pack the flat-mark .ico.

Everything is drawn from the app's own tokens and the app's own mark
(src/assets/mark.svg), so the installer can never drift from the product:

    python3 src-tauri/windows/generate-assets.py

Requires Google Chrome (headless) and sips (macOS). The script writes:

    src-tauri/windows/wiring-header.png    150x57   header strip: mark + wordmark
    src-tauri/windows/wiring-header.bmp    150x57   what NSIS embeds (bottom-up 24bpp)
    src-tauri/windows/wiring-welcome.png   164x314  welcome/finish bitmap: mark + wordmark
    src-tauri/windows/wiring-welcome.bmp   164x314  what NSIS embeds (bottom-up 24bpp)
    src-tauri/windows/wiring-btn-next.png   88x26    primary action, "Next >"
    src-tauri/windows/wiring-btn-next.bmp   88x26    what NSIS embeds
    src-tauri/windows/wiring-btn-finish.png 88x26    primary action, "Finish"
    src-tauri/windows/wiring-btn-finish.bmp 88x26    what NSIS embeds
    src-tauri/icons/icon-flat.ico           16/24/32/48/64/256, flat mark, PNG payloads

NSIS cannot load PNG branding images and rejects top-down bitmaps
(!pragma verifyloadimage), so every bitmap is also written as a bottom-up
24-bit Windows bitmap.
"""

import base64
import os
import struct
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WIN = os.path.join(REPO, "src-tauri", "windows")
ICONS = os.path.join(REPO, "src-tauri", "icons")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP = "/tmp/wiring-assets"

# The app's tokens (src/styles/theme.css).
PLUM = "#1c1624"  # Midnight Plum: page canvas, header ground
CARD = "#2d2734"  # Shadow Plum
BONE = "#f1f0ec"  # Bone White
MUTED = "#a5a2a5"  # Mid Ash
GREEN = "#00f575"  # Signal Green: the one primary action
INK = "#05210f"  # text on Signal Green

FONT_PATH = os.path.join(
    REPO, "node_modules", "@fontsource-variable", "geist", "files", "geist-latin-wght-normal.woff2"
)


def mark_svg() -> str:
    """The app's flat mark, re-hosted in an <svg> that fills its box."""
    raw = open(os.path.join(REPO, "src", "assets", "mark.svg")).read()
    inner = raw.split(">", 1)[1].rsplit("</svg>", 1)[0]
    inner = inner.replace('id="hept"', 'id="hept-a"').replace("url(#hept)", "url(#hept-a)")
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" '
        'preserveAspectRatio="xMidYMid meet" width="100%" height="100%">' + inner + "</svg>"
    )


def page(body: str, width: int, height: int, bg: str = "transparent") -> str:
    font = base64.b64encode(open(FONT_PATH, "rb").read()).decode()
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
@font-face {{
  font-family: "Geist";
  src: url(data:font/woff2;base64,{font}) format("woff2");
  font-weight: 100 900;
}}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; padding: 0; width: {width}px; height: {height}px;
              background: {bg}; overflow: hidden; }}
body {{ font-family: "Geist", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }}
.mark {{ display: block; }}
</style></head><body>
{body}
</body></html>
"""


def screenshot(name: str, html: str, width: int, height: int, transparent: bool = False) -> str:
    os.makedirs(TMP, exist_ok=True)
    html_path = os.path.join(TMP, f"{name}.html")
    png_path = os.path.join(TMP, f"{name}.png")
    open(html_path, "w").write(html)
    cmd = [
        CHROME,
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        f"--window-size={width},{height}",
    ]
    if transparent:
        cmd.append("--default-background-color=00000000")
    cmd += [f"--screenshot={png_path}", f"file://{html_path}"]
    subprocess.run(cmd, capture_output=True, check=True)
    return png_path


def png_to_bottom_up_bmp(png_path: str, bmp_path: str) -> None:
    """Convert a PNG to a bottom-up 24-bit Windows bitmap.

    sips writes top-down bitmaps (a negative height), which NSIS refuses:
    "!pragma verifyloadimage" only accepts BITMAPCOREHEADER/BITMAPINFOHEADER
    bitmaps whose height is positive.
    """
    top_down = subprocess.run(
        ["sips", "-s", "format", "bmp", png_path, "--out", bmp_path + ".tmp"],
        capture_output=True,
        check=True,
    )
    data = open(bmp_path + ".tmp", "rb").read()
    os.remove(bmp_path + ".tmp")

    if data[:2] != b"BM":
        raise SystemExit(f"{png_path}: not a bitmap")
    offset = struct.unpack("<I", data[10:14])[0]
    dib = data[14:offset]
    header_size = struct.unpack("<I", dib[:4])[0]
    width, height, planes, bpp = struct.unpack("<iiHH", dib[4:16])
    if header_size != 40:
        raise SystemExit(f"{png_path}: expected a BITMAPINFOHEADER, got {header_size}")
    if height >= 0:
        raise SystemExit(f"{png_path}: expected a top-down bitmap to flip")
    height = -height
    row_bytes = ((width * bpp + 31) // 32) * 4
    pixels = data[offset:]
    rows = [pixels[i * row_bytes : (i + 1) * row_bytes] for i in range(height)]
    rows.reverse()  # bottom-up

    file_size = 14 + len(dib) + len(pixels)
    out = bytearray()
    out += b"BM"
    out += struct.pack("<IHHI", file_size, 0, 0, 14 + len(dib))
    out += dib[:4]
    out += struct.pack("<iiHH", width, height, planes, bpp)
    out += dib[16:]  # compression, size, resolution, palette, colors
    out += b"".join(rows)
    open(bmp_path, "wb").write(bytes(out))


def pack_ico(paths: list[tuple[int, str]], ico_path: str) -> None:
    """Pack PNG payloads into an ICO container (6-byte header + 16-byte entries)."""
    images = []
    for size, png in paths:
        images.append((size, open(png, "rb").read()))
    images.sort(key=lambda item: item[0])

    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = bytearray()
    payloads = bytearray()
    for size, payload in images:
        entries += struct.pack(
            "<BBBBHHII",
            0 if size >= 256 else size,
            0 if size >= 256 else size,
            0,
            0,
            1,
            32,
            len(payload),
            offset,
        )
        payloads += payload
        offset += len(payload)
    open(ico_path, "wb").write(header + bytes(entries) + bytes(payloads))


def main() -> int:
    os.makedirs(WIN, exist_ok=True)
    mark = mark_svg()

    # -- header strip: 150x57, plum ground, mark + wordmark --------------------
    header = f"""
<div class="mark" style="position:absolute;left:9px;top:13px;width:31px;height:31px">{mark}</div>
<div style="position:absolute;left:50px;top:0;height:57px;display:flex;align-items:center;
            font-size:16px;font-weight:600;letter-spacing:-0.02em;color:{BONE}">Wiring</div>
"""
    png = screenshot("wiring-header", page(header, 150, 57, PLUM), 150, 57)
    open(os.path.join(WIN, "wiring-header.png"), "wb").write(open(png, "rb").read())
    png_to_bottom_up_bmp(png, os.path.join(WIN, "wiring-header.bmp"))

    # -- welcome / finish bitmap: 164x314, plum ground, mark + wordmark --------
    welcome = f"""
<div class="mark" style="position:absolute;left:36px;top:74px;width:92px;height:92px">{mark}</div>
<div style="position:absolute;left:0;top:186px;width:164px;text-align:center;
     font-size:21px;font-weight:600;letter-spacing:-0.02em;color:{BONE}">Wiring</div>
<div style="position:absolute;left:52px;top:222px;width:60px;height:1px;
     background:rgba(229,231,235,0.18)"></div>
<div style="position:absolute;left:0;top:240px;width:164px;text-align:center;
     font-size:10px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:{MUTED}">Setup</div>
"""
    png = screenshot("wiring-welcome", page(welcome, 164, 314, PLUM), 164, 314)
    open(os.path.join(WIN, "wiring-welcome.png"), "wb").write(open(png, "rb").read())
    png_to_bottom_up_bmp(png, os.path.join(WIN, "wiring-welcome.bmp"))

    # -- the one primary action: Signal Green ----------------------------------
    def button(label: str) -> str:
        return f"""
<div style="position:absolute;left:0;top:0;width:88px;height:26px;border-radius:8px;
     background:{GREEN};display:flex;align-items:center;justify-content:center;
     font-size:12px;font-weight:600;color:{INK}">{label}</div>
"""

    for name, label in (("wiring-btn-next", "Next &gt;"), ("wiring-btn-finish", "Finish")):
        png = screenshot(name, page(button(label), 88, 26), 88, 26)
        open(os.path.join(WIN, f"{name}.png"), "wb").write(open(png, "rb").read())
        png_to_bottom_up_bmp(png, os.path.join(WIN, f"{name}.bmp"))

    # -- the flat mark, for the installer .ico ---------------------------------
    entries = []
    for size in (16, 24, 32, 48, 64, 256):
        body = f"""
<div class="mark" style="position:absolute;left:0;top:0;width:{size}px;height:{size}px">{mark}</div>
"""
        png = screenshot(f"wiring-mark-{size}", page(body, size, size), size, size, transparent=True)
        entries.append((size, png))
    pack_ico(entries, os.path.join(ICONS, "icon-flat.ico"))

    # -- the flat mark as PNGs: Linux takes its icons from these, and the desktop
    #    entry points at them. The plate stays in the .icns (macOS) and the .ico
    #    (the Windows app), where the rounded ground still reads at a glance.
    for size, name in ((32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png"), (512, "icon.png")):
        body = f"""
<div class="mark" style="position:absolute;left:0;top:0;width:{size}px;height:{size}px">{mark}</div>
"""
        png = screenshot(f"wiring-icon-{size}", page(body, size, size), size, size, transparent=True)
        open(os.path.join(ICONS, name), "wb").write(open(png, "rb").read())

    print("wrote:", ", ".join(sorted(os.listdir(WIN))))
    print("wrote: icon-flat.ico,", ", ".join(("32x32.png", "128x128.png", "128x128@2x.png", "icon.png")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
