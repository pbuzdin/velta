#!/usr/bin/env python3
"""Generate Velta icon sizes from a single source image.

Usage:
    python tools/generate-icons.py IMG_20260808_215950.jpg

Outputs:
    delta-web-app/src-tauri/icons/{32x32,128x128,128x128@2x,icon}.png
    delta-web-app/src-tauri/icons/icon.ico
    app/icons/{icon-192,icon-512,maskable-512}.png
    app/icons/velta-logo-src.png
    app/icons/icon.svg            (traced vector)
    delta-web-app/src-tauri/icons/icon.svg
"""
import io
import struct
import sys
import shutil
from pathlib import Path
from PIL import Image, ImageFilter
import vtracer

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("IMG_20260808_215950.jpg")
ROOT = Path(__file__).resolve().parent.parent
TAURI_ICONS = ROOT / "delta-web-app" / "src-tauri" / "icons"
APP_ICONS = ROOT / "app" / "icons"

TAURI_ICONS.mkdir(parents=True, exist_ok=True)
APP_ICONS.mkdir(parents=True, exist_ok=True)

img = Image.open(SRC).convert("RGBA")
# Make it square by cropping to center if needed.
width, height = img.size
if width != height:
    size = min(width, height)
    left = (width - size) // 2
    top = (height - size) // 2
    img = img.crop((left, top, left + size, top + size))

# Save master source copy for the PWA.
master_full = img.resize((1024, 1024), Image.Resampling.LANCZOS)
master_full.save(APP_ICONS / "velta-logo-src.png", "PNG")


def make_padded(src: Image.Image, scale: float = 0.72, bg: tuple = (13, 20, 34, 255)) -> Image.Image:
    """Scale the logo down and center it on a background of the same dark color.

    This gives Windows/Android icons healthy padding so the V stays legible at
    small sizes and fits comfortably inside Android's 66dp adaptive-icon safe
    zone.
    """
    size = src.size[0]
    out = Image.new("RGBA", src.size, bg)
    inner_size = int(size * scale)
    inner = src.resize((inner_size, inner_size), Image.Resampling.LANCZOS)
    offset = (size - inner_size) // 2
    out.paste(inner, (offset, offset))
    return out


master = make_padded(master_full)

# Tauri icon sizes.
sizes = {
    TAURI_ICONS / "32x32.png": (32, 32),
    TAURI_ICONS / "128x128.png": (128, 128),
    TAURI_ICONS / "128x128@2x.png": (256, 256),
    TAURI_ICONS / "icon.png": (1024, 1024),
    APP_ICONS / "icon-192.png": (192, 192),
    APP_ICONS / "icon-512.png": (512, 512),
    APP_ICONS / "maskable-512.png": (512, 512),
}

for dest, (w, h) in sizes.items():
    resized = master.resize((w, h), Image.Resampling.LANCZOS)
    # The source already has a dark background matching the app, so use as-is.
    if dest.name == "maskable-512.png":
        # Ensure the logo sits well inside the maskable safe zone by padding.
        padded = Image.new("RGBA", (w, h), (15, 15, 20, 255))
        inner = int(w * 0.80)
        offset = (w - inner) // 2
        inner_img = master.resize((inner, inner), Image.Resampling.LANCZOS)
        padded.paste(inner_img, (offset, offset))
        resized = padded
    resized.save(dest, "PNG")

# Windows .ico with common sizes.
# Pillow's ICO writer only stores a single frame in this configuration, so we
# build the multi-size ICO file manually (PNG data for each size).
ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

ico_path = TAURI_ICONS / "icon.ico"
with open(ico_path, "wb") as ico:
    # ICONDIR: reserved, type=1 (icon), count
    ico.write(struct.pack("<HHH", 0, 1, len(ico_sizes)))
    image_data = []
    offset = 6 + 16 * len(ico_sizes)  # header + directory entries
    for w, h in ico_sizes:
        resized = master.resize((w, h), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        resized.save(buf, format="PNG")
        data = buf.getvalue()
        # ICONDIRENTRY
        ico.write(struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(data), offset))
        image_data.append(data)
        offset += len(data)
    for data in image_data:
        ico.write(data)

# Android adaptive + legacy launcher icons.
ANDROID_RES = ROOT / "delta-web-app" / "src-tauri" / "gen" / "android" / "app" / "src" / "main" / "res"


def extract_foreground_and_background(src: Image.Image, sample_border: int = 80):
    """Separate the logo (foreground) from its background for Android adaptive icons.

    Returns a (foreground RGBA, background RGB tuple). The foreground has the
    original V logo with the uniform dark background made transparent.
    """
    w, h = src.size
    border = []
    for x in range(w):
        for y in range(sample_border):
            border.append(src.getpixel((x, y))[:3])
            border.append(src.getpixel((x, h - 1 - y))[:3])
    for y in range(sample_border, h - sample_border):
        for x in range(sample_border):
            border.append(src.getpixel((x, y))[:3])
            border.append(src.getpixel((w - 1 - x, y))[:3])
    n = len(border)
    bg = (
        sum(p[0] for p in border) // n,
        sum(p[1] for p in border) // n,
        sum(p[2] for p in border) // n,
    )

    # Distance from background color -> alpha mask.
    pixels = src.getdata()
    mask_pixels = []
    lo, hi = 35, 100
    for r, g, b, _ in pixels:
        dist = ((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2) ** 0.5
        if dist <= lo:
            alpha = 0
        elif dist >= hi:
            alpha = 255
        else:
            alpha = int((dist - lo) / (hi - lo) * 255)
        mask_pixels.append(alpha)

    mask = Image.new("L", src.size)
    mask.putdata(mask_pixels)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=2))

    fg = src.copy()
    fg.putalpha(mask)
    return fg, bg


fg_orig, bg_color = extract_foreground_and_background(master)

# Android adaptive icon densities: 108dp canvas.
android_adaptive = {
    "mipmap-mdpi": 108,
    "mipmap-hdpi": 162,
    "mipmap-xhdpi": 216,
    "mipmap-xxhdpi": 324,
    "mipmap-xxxhdpi": 432,
}
for folder, size in android_adaptive.items():
    (ANDROID_RES / folder).mkdir(parents=True, exist_ok=True)
    fg = fg_orig.resize((size, size), Image.Resampling.LANCZOS)
    fg.save(ANDROID_RES / folder / "ic_launcher_foreground.png", "PNG")
    # Legacy square/round icons use the full icon.
    legacy = master.resize((size, size), Image.Resampling.LANCZOS)
    legacy.save(ANDROID_RES / folder / "ic_launcher.png", "PNG")
    legacy.save(ANDROID_RES / folder / "ic_launcher_round.png", "PNG")

# Adaptive icon XML and background color.
(ANDROID_RES / "mipmap-anydpi-v26").mkdir(parents=True, exist_ok=True)
(ANDROID_RES / "mipmap-anydpi-v26" / "ic_launcher.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
    '  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
    '  <background android:drawable="@color/ic_launcher_background"/>\n'
    '</adaptive-icon>\n',
    encoding="utf-8",
)
(ANDROID_RES / "values").mkdir(parents=True, exist_ok=True)
bg_hex = "#{:02x}{:02x}{:02x}".format(bg_color[0], bg_color[1], bg_color[2])
(ANDROID_RES / "values" / "ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<resources>\n'
    f'  <color name="ic_launcher_background">{bg_hex}</color>\n'
    '</resources>\n',
    encoding="utf-8",
)

# Vector trace for an SVG version.
svg_tmp = ROOT / "_tmp_icon_trace.svg"
vtracer.vtracer.convert_image_to_svg_py(
    str(APP_ICONS / "velta-logo-src.png"),
    str(svg_tmp),
    colormode="color",
    hierarchical="stacked",
    mode="spline",
    filter_speckle=4,
    color_precision=6,
    layer_difference=16,
    corner_threshold=30,
    length_threshold=5,
    max_iterations=10,
    splice_threshold=45,
    path_precision=5,
)
shutil.copy(svg_tmp, APP_ICONS / "icon.svg")
shutil.copy(svg_tmp, TAURI_ICONS / "icon.svg")
svg_tmp.unlink()

print("Icons generated:")
for f in sorted(TAURI_ICONS.glob("*")):
    print(f"  {f.relative_to(ROOT)}")
for f in sorted(APP_ICONS.glob("*")):
    print(f"  {f.relative_to(ROOT)}")
