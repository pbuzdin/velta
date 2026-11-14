"""Velta KMP launcher icon → Android adaptive icons (vector) + legacy PNGs + mask preview.

Usage (from velta-kmp/): python3 art/make_android_icon.py composeApp/src/androidMain/res [preview.png]
Needs cairosvg, numpy, Pillow. Source: art/velta-kmp-icon.svg.

Optical centring (Pavel, #334): the V is wide at the top and pointed at the
bottom, so centring its bounding box makes it look high. Two placements, one
scale (the bbox fit into the 66/108 safe circle, 94 % margin):
  - ic_launcher_round → A: the V's area-weighted centroid at the canvas centre
    (circle-only icon, true visual centre);
  - ic_launcher       → B: halfway between the bbox centre and the centroid
    (squircle / rounded-square masks).
Both share the gradient background; each has its own foreground + monochrome.
"""
import re, io, os, sys
import cairosvg
import numpy as np
from PIL import Image, ImageDraw

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'velta-kmp-icon.svg')
RES = sys.argv[1]
PREVIEW = sys.argv[2] if len(sys.argv) > 2 else 'adaptive-preview.png'
s = open(SRC).read()
grad = re.search(r'<linearGradient id="kbg"(.*?)</linearGradient>', s, re.S)
stops = re.findall(r'<stop offset="([\d.]+)" stop-color="(#[0-9A-Fa-f]{6})"/>', grad.group(1))
paths = [(m.group(1), m.group(2), m.group(3), m.group(4))
         for m in re.finditer(r'<path d="([^"]*)" fill="([^"]*)" transform="translate\(([-\d.]+),([-\d.]+)\)"/>', s)]
bgpath, fg = paths[0], paths[1:]
assert bgpath[1] == 'url(#kbg)' and all(p[1].startswith('#') for p in fg)
SAFE = 1024 * 33 / 108
U = 108 / 1024


def fg_svg(t=(0, 0, 1), mono=False):
    body = ''.join(f'<path d="{d}" fill="{"#FFFFFF" if mono else f}" transform="translate({x},{y})"/>' for d, f, x, y in fg)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
            f'<g transform="translate({t[0]:.2f},{t[1]:.2f}) scale({t[2]:.5f})">{body}</g></svg>')


def render(svg, size):
    return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size))).convert('RGBA')


# ---- placement ----
alpha = np.asarray(render(fg_svg(), 1024))[..., 3].astype(float) / 255
ys, xs = np.nonzero(alpha > 0.03)
bbox_c = np.array([(xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2])
yy, xx = np.mgrid[0:1024, 0:1024]
centroid = np.array([(alpha * xx).sum() / alpha.sum(), (alpha * yy).sum() / alpha.sum()])
scale = SAFE * 0.94 / np.sqrt((xs - bbox_c[0]) ** 2 + (ys - bbox_c[1]) ** 2).max()


def placement(anchor):
    sc = min(scale, SAFE * 0.94 / np.sqrt((xs - anchor[0]) ** 2 + (ys - anchor[1]) ** 2).max())
    return (512 - sc * anchor[0], 512 - sc * anchor[1], sc)


VARIANTS = {  # name → (placement, legacy mask)
    'ic_launcher': (placement((bbox_c + centroid) / 2), 'rounded'),   # B
    'ic_launcher_round': (placement(centroid), 'circle'),             # A
}
for name, (t, _) in VARIANTS.items():
    land = (np.array(t[:2]) + t[2] * centroid - 512) * U
    rmax = np.sqrt((t[0] + t[2] * xs - 512) ** 2 + (t[1] + t[2] * ys - 512) ** 2).max() * U
    assert rmax < 33, (name, rmax)
    print(f'{name}: scale={t[2]:.4f} centroid at dx={land[0]:+.2f} dy={land[1]:+.2f} dp, max radius {rmax:.2f}/33 dp')


# ---- vector drawables ----
def argb(c): return '#FF' + c[1:].upper()


def vd(groups, extra_ns=''):
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<!-- Generated from velta-kmp/art/velta-kmp-icon.svg by art/make_android_icon.py. -->\n'
            f'<vector xmlns:android="http://schemas.android.com/apk/res/android"{extra_ns}\n'
            '    android:width="108dp" android:height="108dp"\n'
            '    android:viewportWidth="1024" android:viewportHeight="1024">\n' + groups + '</vector>\n')


def fg_groups(t, mono):
    inner = ''.join(
        f'        <group android:translateX="{x}" android:translateY="{y}">\n'
        f'            <path android:fillColor="{"#FFFFFFFF" if mono else argb(f)}" android:pathData="{d.strip()}"/>\n'
        f'        </group>\n' for d, f, x, y in fg)
    return (f'    <group android:translateX="{t[0]:.2f}" android:translateY="{t[1]:.2f}"\n'
            f'        android:scaleX="{t[2]:.5f}" android:scaleY="{t[2]:.5f}">\n{inner}    </group>\n')


stop_xml = ''.join(f'                <item android:offset="{o}" android:color="{argb(c)}"/>\n' for o, c in stops)
os.makedirs(f'{RES}/drawable', exist_ok=True)
os.makedirs(f'{RES}/mipmap-anydpi-v26', exist_ok=True)
open(f'{RES}/drawable/ic_launcher_background.xml', 'w').write(vd(
    '    <path android:pathData="M0,0h1024v1024h-1024z">\n'
    '        <aapt:attr name="android:fillColor">\n'
    '            <gradient android:type="linear" android:startX="0" android:startY="0"\n'
    '                android:endX="1024" android:endY="1024">\n' + stop_xml +
    '            </gradient>\n        </aapt:attr>\n    </path>\n',
    extra_ns='\n    xmlns:aapt="http://schemas.android.com/aapt"'))
for name, (t, _) in VARIANTS.items():
    open(f'{RES}/drawable/{name}_foreground.xml', 'w').write(vd(fg_groups(t, False)))
    open(f'{RES}/drawable/{name}_monochrome.xml', 'w').write(vd(fg_groups(t, True)))
    open(f'{RES}/mipmap-anydpi-v26/{name}.xml', 'w').write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@drawable/ic_launcher_background"/>\n'
        f'    <foreground android:drawable="@drawable/{name}_foreground"/>\n'
        f'    <monochrome android:drawable="@drawable/{name}_monochrome"/>\n'
        '</adaptive-icon>\n')

# ---- composites ----
gstops = ''.join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in stops)


def full_svg(t):
    inner = fg_svg(t)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
            f'<defs><linearGradient id="g" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">{gstops}</linearGradient></defs>'
            f'<rect width="1024" height="1024" fill="url(#g)"/>' + inner[inner.index('<g '):-6] + '</svg>')


def visible(img):  # launchers show the inner 72/108
    w = img.size[0]; m = w * 18 // 108
    return img.crop((m, m, w - m, w - m))


def mask(kind, n):
    N = n * 4
    if kind == 'squircle':
        y, x = np.mgrid[0:N, 0:N] / (N - 1) * 2 - 1
        m = Image.fromarray(((np.abs(x) ** 4 + np.abs(y) ** 4) <= 1).astype('uint8') * 255)
    else:
        m = Image.new('L', (N, N), 0); d = ImageDraw.Draw(m)
        if kind == 'circle': d.ellipse((0, 0, N - 1, N - 1), fill=255)
        else: d.rounded_rectangle((0, 0, N - 1, N - 1), radius=int(N * 0.22), fill=255)
    return m.resize((n, n), Image.LANCZOS)


views = {name: visible(render(full_svg(t), 1080)) for name, (t, _) in VARIANTS.items()}

# ---- legacy PNGs: ic_launcher = B rounded square, ic_launcher_round = A circle ----
for dens, px in (('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)):
    os.makedirs(f'{RES}/mipmap-{dens}', exist_ok=True)
    for name, (_, kind) in VARIANTS.items():
        out = Image.new('RGBA', (px, px), (0, 0, 0, 0))
        out.paste(views[name].resize((px, px), Image.LANCZOS), (0, 0), mask(kind, px))
        out.save(f'{RES}/mipmap-{dens}/{name}.png', optimize=True)

# ---- preview: row 1 ic_launcher (B) squircle / rounded / circle / guide / themed;
#               row 2 ic_launcher_round (A) circle / guide / themed ----
P, G = 300, 24


def tile(img, kind):
    t = Image.new('RGBA', (P, P), (0, 0, 0, 0)); t.paste(img.resize((P, P), Image.LANCZOS), (0, 0), mask(kind, P)); return t


def guide(name):
    t, _ = VARIANTS[name]
    g = tile(views[name], 'circle'); d = ImageDraw.Draw(g); r = P * 33 / 72; c = P / 2
    d.ellipse((c - r, c - r, c + r, c + r), outline=(255, 230, 0, 255), width=2)
    d.line((c, 0, c, P), fill=(0, 255, 160, 255)); d.line((0, c, P, c), fill=(0, 255, 160, 255))
    px = (np.array(t[:2]) + t[2] * centroid - 1024 * 18 / 108) / (1024 * 72 / 108) * P
    d.ellipse((px[0] - 5, px[1] - 5, px[0] + 5, px[1] + 5), fill=(255, 60, 60, 255))
    return g


def themed(name):
    t, _ = VARIANTS[name]
    mono = visible(render(fg_svg(t, mono=True), 1080)).resize((P, P), Image.LANCZOS)
    th = Image.new('RGBA', (P, P), (0, 0, 0, 0)); cm = mask('circle', P)
    th.paste(Image.new('RGBA', (P, P), (210, 228, 255, 255)), (0, 0), cm)
    th.paste(Image.new('RGBA', (P, P), (20, 60, 120, 255)), (0, 0),
             Image.fromarray(np.minimum(np.asarray(mono)[..., 3], np.asarray(cm))))
    return th


rows = [
    ('ic_launcher (B)', [tile(views['ic_launcher'], k) for k in ('squircle', 'rounded', 'circle')]
     + [guide('ic_launcher'), themed('ic_launcher')]),
    ('ic_launcher_round (A)', [tile(views['ic_launcher_round'], 'circle'), guide('ic_launcher_round'), themed('ic_launcher_round')]),
]
sheet = Image.new('RGBA', (260 + 5 * (P + G), 2 * (P + G) + G), (236, 236, 240, 255)); d = ImageDraw.Draw(sheet)
try:
    from PIL import ImageFont
    F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 20)
except Exception:
    F = None
for j, (label, tiles) in enumerate(rows):
    y = G + j * (P + G)
    d.text((14, y + P // 2 - 10), label, fill=(20, 20, 20), font=F)
    for i, t in enumerate(tiles): sheet.alpha_composite(t, (260 + i * (P + G), y))
sheet.convert('RGB').save(PREVIEW)
