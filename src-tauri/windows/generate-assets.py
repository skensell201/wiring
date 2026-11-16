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
    src-tauri/icons/icon-flat.ico           16/24/32/48/64/256, flat mark, BMP payloads

NSIS cannot load PNG branding images and rejects top-down bitmaps
(!pragma verifyloadimage), so every bitmap is also written as a bottom-up
24-bit Windows bitmap.

The .ico files carry BMP payloads, not PNG ones: the Windows Installer reads
the icon out of an MSI with the old icon API, which cannot decode a PNG, and
falls back to the generic installer icon when it finds one. Explorer itself
reads PNG icons fine, so the bug only shows on the MSI.
"""

import base64
import os
import struct
import subprocess
import sys
import zlib

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


def decode_png(data: bytes) -> tuple[int, int, bytes]:
    """The pixels of an 8-bit PNG (RGB or RGBA), as RGBA rows. Chrome writes those."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("not a PNG")
    pos = 8
    idat = b""
    width = height = 0
    color = 0
    while pos + 8 <= len(data):
        length = int.from_bytes(data[pos : pos + 4], "big")
        kind = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            width = int.from_bytes(chunk[0:4], "big")
            height = int.from_bytes(chunk[4:8], "big")
            depth, color, _, _, interlace = chunk[8], chunk[9], chunk[10], chunk[11], chunk[12]
            if depth != 8 or interlace != 0:
                raise SystemExit("only 8-bit, non-interlaced PNGs")
            if color not in (2, 6):
                raise SystemExit("only RGB and RGBA PNGs")
        elif kind == b"IDAT":
            idat += chunk
        elif kind == b"IEND":
            break

    channels = 3 if color == 2 else 4
    stride = width * channels
    raw = zlib.decompress(idat)
    out = bytearray()
    prev = bytearray(stride)
    at = 0
    for _ in range(height):
        f = raw[at]
        at += 1
        line = bytearray(raw[at : at + stride])
        at += stride
        for i in range(stride):
            a = line[i - channels] if i >= channels else 0
            b = prev[i]
            c = prev[i - channels] if i >= channels else 0
            x = line[i]
            if f == 1:
                x += a
            elif f == 2:
                x += b
            elif f == 3:
                x += (a + b) // 2
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                x += a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
            line[i] = x & 0xFF
        out += line
        prev = line

    rgba = bytearray()
    for y in range(height):
        row = out[y * stride : (y + 1) * stride]
        for x in range(width):
            px = row[x * channels : (x + 1) * channels]
            rgba += bytes(px) + (b"\xff" if channels == 3 else b"")
    return width, height, bytes(rgba)


def ico_bmp_payload(width: int, height: int, rgba: bytes) -> bytes:
    """One ICO entry as a 32-bit DIB: the header, the pixels bottom-up, and an empty mask."""
    header = struct.pack("<IiiHHIIiiII", 40, width, height * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    xor = bytearray()
    for y in range(height - 1, -1, -1):  # bottom-up
        for x in range(width):
            r, g, b, a = rgba[(y * width + x) * 4 : (y * width + x) * 4 + 4]
            xor += bytes((b, g, r, a))
    mask = bytes(((width + 31) // 32) * 4 * height)
    return header + bytes(xor) + mask


def pack_ico_bmp(entries: list[tuple[int, bytes]], ico_path: str) -> None:
    """Pack ICO entries given as (size, DIB payload) pairs."""
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    directory = bytearray()
    payloads = bytearray()
    for size, payload in entries:
        directory += struct.pack(
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
    open(ico_path, "wb").write(header + bytes(directory) + bytes(payloads))


def ico_png_to_bmp(ico_path: str) -> bool:
    """Rewrite an .ico so that its PNG entries become BMP ones. The pixels do not change.

    The Windows Installer cannot read a PNG icon and falls back to the generic installer
    icon, so an .ico that is meant for an MSI has to carry BMP payloads. Entries that are
    already BMP are kept as they are.
    """
    data = open(ico_path, "rb").read()
    reserved, kind, count = struct.unpack("<HHH", data[:6])
    if reserved != 0 or kind != 1:
        raise SystemExit(f"{ico_path}: not an icon file")
    entries: list[tuple[int, bytes]] = []
    changed = False
    at = 6
    for _ in range(count):
        width, height, _, _, planes, _, size, offset = struct.unpack("<BBBBHHII", data[at : at + 16])
        at += 16
        payload = data[offset : offset + size]
        if payload[:8] == b"\x89PNG\r\n\x1a\n":
            w, h, rgba = decode_png(payload)
            payload = ico_bmp_payload(w, h, rgba)
            changed = True
        entries.append((width or 256, payload))
    if changed:
        pack_ico_bmp(entries, ico_path)
    return changed


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
    # BMP payloads, not PNG ones: the Windows Installer cannot decode a PNG icon.
    entries = []
    for size in (16, 24, 32, 48, 64, 256):
        body = f"""
<div class="mark" style="position:absolute;left:0;top:0;width:{size}px;height:{size}px">{mark}</div>
"""
        png = screenshot(f"wiring-mark-{size}", page(body, size, size), size, size, transparent=True)
        w, h, rgba = decode_png(open(png, "rb").read())
        entries.append((size, ico_bmp_payload(w, h, rgba)))
    pack_ico_bmp(entries, os.path.join(ICONS, "icon-flat.ico"))

    # -- the Windows application icon (the plate) --------------------------------
    # The plate's source image is not in the repository, so the committed .ico is rewritten
    # in place: same pixels, BMP payloads, so the MSI that carries it shows the mark.
    app_ico = os.path.join(ICONS, "icon.ico")
    print("icon.ico:", "rewritten with BMP payloads" if ico_png_to_bmp(app_ico) else "already BMP")

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
