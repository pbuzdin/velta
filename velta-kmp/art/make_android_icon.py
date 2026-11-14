"""Velta KMP launcher icon → Android adaptive icon (vector) + legacy PNGs + mask preview.

Usage (from velta-kmp/): python3 art/make_android_icon.py composeApp/src/androidMain/res [preview.png]
Needs cairosvg, numpy, Pillow. Source: art/velta-kmp-icon.svg."""
import re, io, os, sys, math
import cairosvg
import numpy as np
from PIL import Image, ImageDraw

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'velta-kmp-icon.svg')
PREVIEW = sys.argv[2] if len(sys.argv) > 2 else 'adaptive-preview.png'
RES = sys.argv[1]
s = open(SRC).read()
grad = re.search(r'<linearGradient id="kbg"(.*?)</linearGradient>', s, re.S)
stops = re.findall(r'<stop offset="([\d.]+)" stop-color="(#[0-9A-Fa-f]{6})"/>', grad.group(1))
paths = [(m.group(1), m.group(2), m.group(3), m.group(4))
         for m in re.finditer(r'<path d="([^"]*)" fill="([^"]*)" transform="translate\(([-\d.]+),([-\d.]+)\)"/>', s)]
bgpath, fg = paths[0], paths[1:]
assert bgpath[1] == 'url(#kbg)' and all(p[1].startswith('#') for p in fg)

def fg_svg(transform='', mono=False):
    body = ''.join(f'<path d="{d}" fill="{"#FFFFFF" if mono else f}" transform="translate({x},{y})"/>' for d, f, x, y in fg)
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><g transform="{transform}">{body}</g></svg>'

def render(svg, size):
    return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size))).convert('RGBA')

# Fit the V into the 66/108 safe circle (radius 313 of 1024), centred, with margin.
a = np.asarray(render(fg_svg(), 1024))[..., 3] > 8
ys, xs = np.nonzero(a)
cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
rmax = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2).max()
SAFE = 1024 * 33 / 108
scale = SAFE * 0.94 / rmax
tx, ty = 512 - scale * cx, 512 - scale * cy
print(f'V bbox x{xs.min()}..{xs.max()} y{ys.min()}..{ys.max()} rmax={rmax:.1f} scale={scale:.4f}')
T = f'translate({tx:.2f},{ty:.2f}) scale({scale:.5f})'

# ---- vector drawables ----
def argb(c): return '#FF' + c[1:].upper()
def vd(groups, extra_ns=''):
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<!-- Generated from velta-kmp/art/velta-kmp-icon.svg by art/make_android_icon.py. -->\n'
            f'<vector xmlns:android="http://schemas.android.com/apk/res/android"{extra_ns}\n'
            '    android:width="108dp" android:height="108dp"\n'
            '    android:viewportWidth="1024" android:viewportHeight="1024">\n' + groups + '</vector>\n')
def fg_groups(mono):
    inner = ''.join(
        f'        <group android:translateX="{x}" android:translateY="{y}">\n'
        f'            <path android:fillColor="{"#FFFFFFFF" if mono else argb(f)}" android:pathData="{d.strip()}"/>\n'
        f'        </group>\n' for d, f, x, y in fg)
    return (f'    <group android:translateX="{tx:.2f}" android:translateY="{ty:.2f}"\n'
            f'        android:scaleX="{scale:.5f}" android:scaleY="{scale:.5f}">\n{inner}    </group>\n')
stop_xml = ''.join(f'                <item android:offset="{o}" android:color="{argb(c)}"/>\n' for o, c in stops)
bg_xml = vd(
    '    <path android:pathData="M0,0h1024v1024h-1024z">\n'
    '        <aapt:attr name="android:fillColor">\n'
    '            <gradient android:type="linear" android:startX="0" android:startY="0"\n'
    '                android:endX="1024" android:endY="1024">\n' + stop_xml +
    '            </gradient>\n        </aapt:attr>\n    </path>\n',
    extra_ns='\n    xmlns:aapt="http://schemas.android.com/aapt"')
os.makedirs(f'{RES}/drawable', exist_ok=True)
open(f'{RES}/drawable/ic_launcher_background.xml', 'w').write(bg_xml)
open(f'{RES}/drawable/ic_launcher_foreground.xml', 'w').write(vd(fg_groups(False)))
open(f'{RES}/drawable/ic_launcher_monochrome.xml', 'w').write(vd(fg_groups(True)))
adaptive = ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@drawable/ic_launcher_background"/>\n'
            '    <foreground android:drawable="@drawable/ic_launcher_foreground"/>\n'
            '    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n'
            '</adaptive-icon>\n')
os.makedirs(f'{RES}/mipmap-anydpi-v26', exist_ok=True)
for n in ('ic_launcher', 'ic_launcher_round'):
    open(f'{RES}/mipmap-anydpi-v26/{n}.xml', 'w').write(adaptive)

# ---- adaptive composite (108-unit canvas) via cairo ----
gstops = ''.join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in stops)
def full_svg(transform):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
            f'<defs><linearGradient id="g" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">{gstops}</linearGradient></defs>'
            f'<rect width="1024" height="1024" fill="url(#g)"/>' + fg_svg(transform)[fg_svg(transform).index('<g '):-6] + '</svg>')
adaptive_img = render(full_svg(T), 1080)          # 108 units × 10 px

def visible(img):  # launchers show the inner 72/108
    w = img.size[0]; m = w * 18 // 108
    return img.crop((m, m, w - m, w - m))

def mask(kind, n):
    m = Image.new('L', (n * 4, n * 4), 0); d = ImageDraw.Draw(m); N = n * 4
    if kind == 'circle': d.ellipse((0, 0, N - 1, N - 1), fill=255)
    elif kind == 'rounded': d.rounded_rectangle((0, 0, N - 1, N - 1), radius=int(N * 0.22), fill=255)
    else:  # squircle |x|^4+|y|^4<=1
        yy, xx = np.mgrid[0:N, 0:N] / (N - 1) * 2 - 1
        m = Image.fromarray(((np.abs(xx) ** 4 + np.abs(yy) ** 4) <= 1).astype('uint8') * 255)
    return m.resize((n, n), Image.LANCZOS)

# ---- legacy PNGs ----
for dens, px in (('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)):
    os.makedirs(f'{RES}/mipmap-{dens}', exist_ok=True)
    base = visible(adaptive_img).resize((px, px), Image.LANCZOS)
    for name, kind in (('ic_launcher', 'rounded'), ('ic_launcher_round', 'circle')):
        out = Image.new('RGBA', (px, px), (0, 0, 0, 0)); out.paste(base, (0, 0), mask(kind, px))
        out.save(f'{RES}/mipmap-{dens}/{name}.png', optimize=True)

# ---- preview: circle / squircle / rounded square + safe-zone guide + themed ----
P = 360; tiles = []
v = visible(adaptive_img).resize((P, P), Image.LANCZOS)
for kind in ('circle', 'squircle', 'rounded'):
    t = Image.new('RGBA', (P, P), (0, 0, 0, 0)); t.paste(v, (0, 0), mask(kind, P)); tiles.append(t)
g = v.copy(); d = ImageDraw.Draw(g); r = P * 33 / 72
d.ellipse((P / 2 - r, P / 2 - r, P / 2 + r, P / 2 + r), outline=(255, 255, 0, 255), width=3); tiles.append(g)
mono = visible(render(fg_svg(T, mono=True), 1080)).resize((P, P), Image.LANCZOS)
th = Image.new('RGBA', (P, P), (0, 0, 0, 0)); bgc = Image.new('RGBA', (P, P), (210, 228, 255, 255))
th.paste(bgc, (0, 0), mask('circle', P)); tint = Image.new('RGBA', (P, P), (20, 60, 120, 255))
th.paste(tint, (0, 0), Image.fromarray(np.minimum(np.asarray(mono)[..., 3], np.asarray(mask('circle', P)))))
tiles.append(th)
sheet = Image.new('RGBA', (len(tiles) * (P + 30) + 30, P + 60), (236, 236, 240, 255))
for i, t in enumerate(tiles): sheet.alpha_composite(t, (30 + i * (P + 30), 30))
sheet.convert('RGB').save(PREVIEW)
# clipping check: no V pixel outside the safe circle
fa = np.asarray(render(fg_svg(T), 1080))[..., 3] > 8
yy, xx = np.nonzero(fa)
print('max V radius (units of 108):', (np.sqrt((xx - 540) ** 2 + (yy - 540) ** 2).max() / 10).round(2), 'safe = 33')
