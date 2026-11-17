#!/usr/bin/env python3
"""Velta KMP launcher icon → Android adaptive icons (vector) + legacy PNGs.

Usage (from velta-kmp/): python3 art/make_android_icon.py composeApp/src/androidMain/res [preview.png]
Needs cairosvg, numpy, Pillow. Source: art/velta-kmp-icon.svg (1024 visible tile).

The SVG is the visible launcher tile. This script:

- Fills the 108-unit adaptive canvas with the SVG background colour (#0A1A2E).
- Maps the 1024 tile into the inner 72/108 (so launchers show it full-bleed,
  and the 196 px K badge stays inside the 66/108 safe circle).
- ic_launcher: designed v-logo placement (square / adaptive).
- ic_launcher_round: the V is shifted down 24 px on the 1024 tile (optical
  nudge for the wide top / pointed bottom); the badge stays put.

Both variants share the background; each has its own foreground + monochrome.
The monochrome layer is a white silhouette of the V plus the badge plate with
the K cut out (even-odd).
"""
from __future__ import annotations

import io
import math
import os
import re
import sys
import xml.etree.ElementTree as ET

import cairosvg
import numpy as np
from PIL import Image, ImageDraw

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "velta-kmp-icon.svg")
RES = sys.argv[1]
PREVIEW = sys.argv[2] if len(sys.argv) > 2 else None

CANVAS = 1024
# Adaptive: 1024 viewport == 108 dp. Visible tile occupies the inner 72 dp.
ADAPT_S = 72 / 108
ADAPT_T = CANVAS * 18 / 108  # 170.666...
ROUND_NUDGE = 24.0  # px down on the 1024 tile
SAFE = CANVAS * 33 / 108
U = 108 / CANVAS  # viewport-px → dp


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_svg(path: str):
    tree = ET.parse(path)
    root = tree.getroot()
    grads = {}
    polys = []
    bg = "#0A1A2E"
    badge = None
    k = None
    for el in root.iter():
        name = local(el.tag)
        if name == "linearGradient":
            gid = el.get("id")
            stops = [
                (float(st.get("offset", "0")), st.get("stop-color"))
                for st in el
                if local(st.tag) == "stop"
            ]
            grads[gid] = {
                "x1": float(el.get("x1")),
                "y1": float(el.get("y1")),
                "x2": float(el.get("x2")),
                "y2": float(el.get("y2")),
                "stops": stops,
            }
        elif name == "polygon":
            pts = [
                (float(x), float(y))
                for x, y in (p.split(",") for p in el.get("points").split())
            ]
            fill = el.get("fill", "")
            gid = fill[5:-1] if fill.startswith("url(#") else None
            polys.append((pts, gid))
        elif name == "rect":
            x = el.get("x")
            if x is None:
                bg = el.get("fill", bg)
            else:
                badge = {
                    "x": float(x),
                    "y": float(el.get("y")),
                    "w": float(el.get("width")),
                    "h": float(el.get("height")),
                    "rx": float(el.get("rx", "0")),
                    "fill": el.get("fill"),
                    "stroke": el.get("stroke"),
                    "sw": float(el.get("stroke-width", "0")),
                }
        elif name == "path" and el.get("transform"):
            # Only the K path has a transform in this SVG.
            tr = el.get("transform")
            tm = re.search(r"translate\(([^,]+),([^\)]+)\)", tr)
            sm = re.search(r"scale\(([^)]+)\)", tr)
            k = {
                "d": el.get("d"),
                "fill": el.get("fill"),
                "tx": float(tm.group(1)),
                "ty": float(tm.group(2)),
                "s": float(sm.group(1)),
            }
    assert grads and polys and badge and k, "unexpected velta-kmp-icon.svg structure"
    badge["gid"] = badge["fill"][5:-1] if badge["fill"].startswith("url(#") else None
    return {"bg": bg, "grads": grads, "polys": polys, "badge": badge, "k": k}


def xf_pt(x, y, typ=0.0, adapt=True):
    """Tile space → 108-unit viewport. typ shifts the V down before mapping."""
    x, y = x, y + typ
    if adapt:
        return ADAPT_T + ADAPT_S * x, ADAPT_T + ADAPT_S * y
    return x, y


def xf_len(v, adapt=True):
    return v * ADAPT_S if adapt else v


def poly_path(pts, typ=0.0):
    cmds = []
    for i, (x, y) in enumerate(pts):
        px, py = xf_pt(x, y, typ)
        cmds.append(("M" if i == 0 else "L") + f"{px:.3f},{py:.3f}")
    return " ".join(cmds) + " Z"


def rounded_rect_path(x, y, w, h, rx, typ=0.0):
    # typ is 0 for the badge (it does not move with the V).
    x0, y0 = xf_pt(x, y, typ)
    x1, y1 = xf_pt(x + w, y + h, typ)
    r = xf_len(rx)
    # Standard rounded-rect, clockwise, SVG-style arcs.
    return (
        f"M{x0+r:.3f},{y0:.3f}"
        f"H{x1-r:.3f}"
        f"A{r:.3f},{r:.3f} 0 0 1 {x1:.3f},{y0+r:.3f}"
        f"V{y1-r:.3f}"
        f"A{r:.3f},{r:.3f} 0 0 1 {x1-r:.3f},{y1:.3f}"
        f"H{x0+r:.3f}"
        f"A{r:.3f},{r:.3f} 0 0 1 {x0:.3f},{y1-r:.3f}"
        f"V{y0+r:.3f}"
        f"A{r:.3f},{r:.3f} 0 0 1 {x0+r:.3f},{y0:.3f}Z"
    )


def transform_svg_path(d, tx, ty, s, typ=0.0):
    """Apply 'translate(tx,ty) scale(s)' (SVG: scale first), then adaptive map.

    typ is included in the tile-space Y so a baked K path could nudge, but the
    badge/K stay at typ=0. Handles the compact M/V/H/L/Z path used for the K.
    """
    tokens = re.findall(r"[MLHVZmlhvz]|-?\d*\.?\d+(?:e[-+]?\d+)?", d)
    out = []
    cmd = None
    i = 0
    cx = cy = 0.0

    def emit(x, y, c):
        px, py = xf_pt(tx + s * x, ty + s * y, typ)
        out.append(f"{c}{px:.3f},{py:.3f}")
        return x, y

    while i < len(tokens):
        t = tokens[i]
        if re.match(r"[A-Za-z]", t):
            cmd = t
            i += 1
            if cmd in "Zz":
                out.append("Z")
            continue
        if cmd in "Mm":
            cx, cy = float(t), float(tokens[i + 1])
            if cmd == "m":
                # relative to previous — not used in our K
                pass
            cx, cy = emit(cx, cy, "M")
            i += 2
            cmd = "L" if cmd == "M" else "l"
        elif cmd == "L":
            cx, cy = emit(float(t), float(tokens[i + 1]), "L")
            i += 2
        elif cmd == "V":
            cy = emit(cx, float(t), "L")[1]
            i += 1
        elif cmd == "H":
            cx = emit(float(t), cy, "L")[0]
            i += 1
        else:
            raise ValueError(f"unhandled command {cmd}")
    return " ".join(out)


def argb(c: str) -> str:
    return "#FF" + c.lstrip("#").upper()


def gradient_xml(grad, typ=0.0):
    x1, y1 = xf_pt(grad["x1"], grad["y1"], typ)
    x2, y2 = xf_pt(grad["x2"], grad["y2"], typ)
    items = "".join(
        f'                <item android:offset="{o}" android:color="{argb(col)}"/>\n'
        for o, col in grad["stops"]
    )
    return (
        "        <aapt:attr name=\"android:fillColor\">\n"
        f'            <gradient android:type="linear" android:startX="{x1:.3f}" android:startY="{y1:.3f}"\n'
        f'                android:endX="{x2:.3f}" android:endY="{y2:.3f}">\n'
        f"{items}"
        "            </gradient>\n"
        "        </aapt:attr>\n"
    )


def vd(groups, extra_ns=""):
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<!-- Generated from velta-kmp/art/velta-kmp-icon.svg by art/make_android_icon.py. -->\n"
        f'<vector xmlns:android="http://schemas.android.com/apk/res/android"{extra_ns}\n'
        '    android:width="108dp" android:height="108dp"\n'
        '    android:viewportWidth="1024" android:viewportHeight="1024">\n'
        f"{groups}</vector>\n"
    )


def foreground_groups(icon, typ, mono=False):
    parts = []
    if mono:
        # White V silhouette.
        for pts, _gid in icon["polys"]:
            parts.append(
                f'    <path android:fillColor="#FFFFFFFF" android:pathData="{poly_path(pts, typ)}"/>\n'
            )
        # Badge plate with the K cut out.
        plate = rounded_rect_path(
            icon["badge"]["x"], icon["badge"]["y"], icon["badge"]["w"],
            icon["badge"]["h"], icon["badge"]["rx"], typ=0.0,
        )
        kpath = transform_svg_path(
            icon["k"]["d"], icon["k"]["tx"], icon["k"]["ty"], icon["k"]["s"], typ=0.0,
        )
        parts.append(
            f'    <path android:fillColor="#FFFFFFFF" android:fillType="evenOdd"\n'
            f'        android:pathData="{plate} {kpath}"/>\n'
        )
        return "".join(parts)

    for pts, gid in icon["polys"]:
        parts.append(
            f'    <path android:pathData="{poly_path(pts, typ)}">\n'
            f'{gradient_xml(icon["grads"][gid], typ)}'
            "    </path>\n"
        )
    b, gid = icon["badge"], icon["badge"]["gid"]
    sw = xf_len(b["sw"])
    parts.append(
        f'    <path android:pathData="{rounded_rect_path(b["x"], b["y"], b["w"], b["h"], b["rx"])}"\n'
        f'        android:strokeColor="{argb(b["stroke"])}" android:strokeWidth="{sw:.3f}">\n'
        f'{gradient_xml(icon["grads"][gid], typ=0.0)}'
        "    </path>\n"
    )
    kpath = transform_svg_path(icon["k"]["d"], icon["k"]["tx"], icon["k"]["ty"], icon["k"]["s"])
    parts.append(
        f'    <path android:fillColor="{argb(icon["k"]["fill"])}" android:pathData="{kpath}"/>\n'
    )
    return "".join(parts)


def tile_svg(icon, typ):
    """Rebuild a 1024 visible-tile SVG, with the V optionally nudged down."""
    grads = []
    for gid, g in icon["grads"].items():
        stops = "".join(
            f'<stop offset="{o}" stop-color="{c}"/>' for o, c in g["stops"]
        )
        grads.append(
            f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" '
            f'x1="{g["x1"]}" y1="{g["y1"]}" x2="{g["x2"]}" y2="{g["y2"]}">{stops}</linearGradient>'
        )
    body = [f"<defs>{''.join(grads)}</defs>"]
    body.append(f'<rect width="1024" height="1024" fill="{icon["bg"]}"/>')
    body.append(f'<g transform="translate(0,{typ})">')
    for pts, gid in icon["polys"]:
        ps = " ".join(f"{x},{y}" for x, y in pts)
        body.append(f'<polygon points="{ps}" fill="url(#{gid})"/>')
    body.append("</g>")
    b = icon["badge"]
    body.append(
        f'<rect x="{b["x"]}" y="{b["y"]}" width="{b["w"]}" height="{b["h"]}" '
        f'rx="{b["rx"]}" fill="url(#{b["gid"]})" stroke="{b["stroke"]}" stroke-width="{b["sw"]}"/>'
    )
    k = icon["k"]
    body.append(
        f'<path d="{k["d"]}" fill="{k["fill"]}" transform="translate({k["tx"]},{k["ty"]}) scale({k["s"]})"/>'
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" '
        f'viewBox="0 0 1024 1024">{"".join(body)}</svg>'
    )


def adapt_svg(icon, typ):
    """108-unit canvas: full-bleed background + the 1024 tile in the inner 72/108."""
    inner = tile_svg(icon, typ)
    # Drop the inner background rect so we don't double-paint; keep V+badge.
    # Easier: wrap the whole tile (including its bg) in the adaptive transform
    # and also paint a full-canvas bg so the 18/108 bleed matches.
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
        f'<rect width="1024" height="1024" fill="{icon["bg"]}"/>'
        f'<g transform="translate({ADAPT_T:.4f},{ADAPT_T:.4f}) scale({ADAPT_S:.6f})">'
        # Re-embed tile without the outer svg wrapper: use the tile as a nested svg.
        f'<svg width="1024" height="1024" viewBox="0 0 1024 1024">{tile_svg(icon, typ)[tile_svg(icon, typ).find(">")+1:-6]}</svg>'
        "</g></svg>"
    )


def render(svg, size):
    buf = cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size)
    return Image.open(io.BytesIO(buf)).convert("RGBA")


def visible(img):
    w = img.size[0]
    m = w * 18 // 108
    return img.crop((m, m, w - m, w - m))


def mask(kind, n):
    N = n * 4
    if kind == "squircle":
        y, x = np.mgrid[0:N, 0:N] / (N - 1) * 2 - 1
        m = Image.fromarray(((np.abs(x) ** 4 + np.abs(y) ** 4) <= 1).astype("uint8") * 255)
    else:
        m = Image.new("L", (N, N), 0)
        d = ImageDraw.Draw(m)
        if kind == "circle":
            d.ellipse((0, 0, N - 1, N - 1), fill=255)
        else:
            d.rounded_rectangle((0, 0, N - 1, N - 1), radius=int(N * 0.22), fill=255)
    return m.resize((n, n), Image.Resampling.LANCZOS)


def fg_alpha(icon, typ, size=1080):
    """Foreground-only (no background) on the 108 canvas, for the safe-zone check."""
    # Render the adaptive composite and subtract the uniform background.
    img = render(adapt_svg(icon, typ), size)
    arr = np.asarray(img)
    bg = tuple(int(icon["bg"].lstrip("#")[i : i + 2], 16) for i in (0, 2, 4))
    dist = np.abs(arr[..., :3].astype(np.int16) - np.array(bg, dtype=np.int16)).sum(-1)
    return dist > 18


def main():
    icon = parse_svg(SRC)
    variants = {
        "ic_launcher": (0.0, "rounded"),
        "ic_launcher_round": (ROUND_NUDGE, "circle"),
    }

    for name, (typ, _) in variants.items():
        a = fg_alpha(icon, typ, 1080)
        ys, xs = np.nonzero(a)
        rmax = float(np.sqrt((xs - 540) ** 2 + (ys - 540) ** 2).max() / 10)  # px→dp (1080=108dp)
        print(f"{name}: typ={typ:g}  foreground max radius {rmax:.2f}/33 dp")
        if rmax >= 33:
            raise SystemExit(f"{name} exceeds the 66/108 safe circle ({rmax:.2f} dp)")

    os.makedirs(f"{RES}/drawable", exist_ok=True)
    os.makedirs(f"{RES}/mipmap-anydpi-v26", exist_ok=True)
    open(f"{RES}/drawable/ic_launcher_background.xml", "w").write(
        vd(
            f'    <path android:pathData="M0,0h1024v1024h-1024z" android:fillColor="{argb(icon["bg"])}"/>\n'
        )
    )
    for name, (typ, _) in variants.items():
        open(f"{RES}/drawable/{name}_foreground.xml", "w").write(
            vd(foreground_groups(icon, typ, mono=False), extra_ns='\n    xmlns:aapt="http://schemas.android.com/aapt"')
        )
        open(f"{RES}/drawable/{name}_monochrome.xml", "w").write(
            vd(foreground_groups(icon, typ, mono=True))
        )
        open(f"{RES}/mipmap-anydpi-v26/{name}.xml", "w").write(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@drawable/ic_launcher_background"/>\n'
            f'    <foreground android:drawable="@drawable/{name}_foreground"/>\n'
            f'    <monochrome android:drawable="@drawable/{name}_monochrome"/>\n'
            "</adaptive-icon>\n"
        )

    views = {name: visible(render(adapt_svg(icon, typ), 1080)) for name, (typ, _) in variants.items()}
    for dens, px in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
        os.makedirs(f"{RES}/mipmap-{dens}", exist_ok=True)
        for name, (_, kind) in variants.items():
            out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
            out.paste(views[name].resize((px, px), Image.Resampling.LANCZOS), (0, 0), mask(kind, px))
            out.save(f"{RES}/mipmap-{dens}/{name}.png", optimize=True)

    if PREVIEW:
        P, G = 300, 24

        def tile(img, kind):
            t = Image.new("RGBA", (P, P), (0, 0, 0, 0))
            t.paste(img.resize((P, P), Image.Resampling.LANCZOS), (0, 0), mask(kind, P))
            return t

        def themed(name, typ):
            # Render monochrome as a themed preview (blue on ice).
            mono_svg = (
                '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
                '<rect width="1024" height="1024" fill="#D2E4FF"/>'
                f'<g transform="translate({ADAPT_T:.4f},{ADAPT_T:.4f}) scale({ADAPT_S:.6f})">'
                + re.sub(
                    r'fill="[^"]+"',
                    'fill="#143C78"',
                    re.sub(
                        r"stop-color=\"#[0-9A-Fa-f]{6}\"",
                        'stop-color="#143C78"',
                        tile_svg(icon, typ)[tile_svg(icon, typ).find(">") + 1 : -6],
                    ),
                )
                + "</g></svg>"
            )
            # Simpler: use the visible crop of a white-on-transparent mono and tint.
            # Fall back to a circle crop of the colour view — the monochrome XML is
            # what Android uses; this preview just shows the cut-out K.
            return tile(views[name], "circle")

        rows = [
            ("ic_launcher", [tile(views["ic_launcher"], k) for k in ("squircle", "rounded", "circle")]),
            ("ic_launcher_round", [tile(views["ic_launcher_round"], "circle")]),
        ]
        sheet = Image.new("RGBA", (240 + 3 * (P + G), 2 * (P + G) + G), (236, 236, 240, 255))
        d = ImageDraw.Draw(sheet)
        try:
            from PIL import ImageFont
            F = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 18)
        except Exception:
            F = None
        for j, (label, tiles) in enumerate(rows):
            y = G + j * (P + G)
            d.text((12, y + P // 2 - 8), label, fill=(20, 20, 20), font=F)
            for i, t in enumerate(tiles):
                sheet.alpha_composite(t, (240 + i * (P + G), y))
        sheet.convert("RGB").save(PREVIEW)
        print("wrote", PREVIEW)


if __name__ == "__main__":
    main()
