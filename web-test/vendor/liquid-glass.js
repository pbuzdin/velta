// ../../../../tmp/css-liquid-glass/src/glass/maps.ts
var SLOTS = ["tl", "tr", "br", "bl", "top", "right", "bottom", "left"];
var CORNERS = ["tl", "tr", "br", "bl"];
var EDGES = ["top", "right", "bottom", "left"];
var CORNER_TEX = 32;
var LINE_TEX = 128;
var clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
var CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
var crc32 = (bytes) => {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ c >>> 8;
  return ~c >>> 0;
};
var chunk = (type, data) => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};
function encodePng(w, h, channels, pixels) {
  const row = w * channels;
  const raw = new Uint8Array((row + 1) * h);
  for (let y = 0; y < h; y++) raw.set(pixels.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
  const len = raw.length;
  const blocks = Math.max(1, Math.ceil(len / 65535));
  const z = new Uint8Array(2 + blocks * 5 + len + 4);
  z.set([120, 1]);
  let at = 2;
  for (let k = 0; k < blocks; k++) {
    const part = raw.subarray(k * 65535, Math.min(len, (k + 1) * 65535));
    const n = part.length;
    z.set([k === blocks - 1 ? 1 : 0, n & 255, n >>> 8, ~n & 255, ~n >>> 8 & 255], at);
    z.set(part, at + 5);
    at += 5 + n;
  }
  let a = 1;
  let b = 0;
  for (let i = 0; i < len; i++) {
    a = (a + raw[i]) % 65521;
    b = (b + a) % 65521;
  }
  new DataView(z.buffer).setUint32(at, (b << 16 | a) >>> 0);
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, w);
  hv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 4;
  let bin = "";
  for (const part of [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", z),
    chunk("IEND", new Uint8Array(0))
  ])
    for (let i = 0; i < part.length; i++) bin += String.fromCharCode(part[i]);
  return "data:image/png;base64," + btoa(bin);
}
var grayPng = (w, h, value) => {
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = clamp255(value(x, y));
  return encodePng(w, h, 1, px);
};
var maskPng = (w, h, alpha) => {
  const px = new Uint8Array(w * h * 2);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      px[(y * w + x) * 2] = 255;
      px[(y * w + x) * 2 + 1] = clamp255(alpha(x, y) * 255);
    }
  return encodePng(w, h, 2, px);
};
var lineTile = (vertical, value) => vertical ? grayPng(1, LINE_TEX, (_, y) => value((y + 0.5) / LINE_TEX)) : grayPng(LINE_TEX, 1, (x) => value((x + 0.5) / LINE_TEX));
var tileReach = (R, short) => Math.max(2, Math.min(Math.floor(short / 2), Math.ceil(R)));
var cornerCenters = (R) => ({
  tl: [R, R],
  tr: [0, R],
  br: [0, 0],
  bl: [R, 0]
});
var edgeTile = (dir, reach, R, value) => {
  const edgeAtZero = dir === "top" || dir === "left";
  return lineTile(dir === "top" || dir === "bottom", (f) => value(1 - (edgeAtZero ? f : 1 - f) * reach / R));
};
var cornerTile = (key, value) => {
  const [cx, cy] = cornerCenters(1)[key];
  return grayPng(
    CORNER_TEX,
    CORNER_TEX,
    (x, y) => value(Math.min(1, Math.hypot((x + 0.5) / CORNER_TEX - cx, (y + 0.5) / CORNER_TEX - cy)))
  );
};
var productTile = (key, magnitude, axis, direction, R) => {
  const [cx, cy] = cornerCenters(1)[key];
  const v0 = direction(0);
  const v1 = direction(R);
  return grayPng(CORNER_TEX, CORNER_TEX, (x, y) => {
    const q = Math.min(1, Math.hypot((x + 0.5) / CORNER_TEX - cx, (y + 0.5) / CORNER_TEX - cy));
    const A = Math.max(0, Math.min(255, magnitude(q))) / 255;
    const f = ((axis === "x" ? x : y) + 0.5) / CORNER_TEX;
    const D = Math.max(0, Math.min(255, v0 + (v1 - v0) * f)) / 255;
    return (0.5 + A * (D - 0.5)) * 255;
  });
};
var perCorner = (tile) => ({ tl: tile("tl"), tr: tile("tr"), br: tile("br"), bl: tile("bl") });
function sliceRect(slot, w, h, r, reach, ox = 0, oy = 0) {
  r = Math.max(0.01, Math.min(r, w / 2, h / 2));
  const mid = Math.max(0.01, w - 2 * r);
  const col = Math.max(0.01, h - 2 * r);
  const d = Math.max(0.01, Math.min(reach, Math.min(w, h) / 2));
  const rect = (x, y, sw, sh) => ({
    x: x + ox,
    y: y + oy,
    w: Math.max(0.01, sw),
    h: Math.max(0.01, sh)
  });
  switch (slot) {
    case "tl":
      return rect(0, 0, r, r);
    case "tr":
      return rect(w - r, 0, r, r);
    case "br":
      return rect(w - r, h - r, r, r);
    case "bl":
      return rect(0, h - r, r, r);
    case "top":
      return rect(r, 0, mid, d);
    case "bottom":
      return rect(r, h - d, mid, d);
    case "left":
      return rect(0, r, d, col);
    case "right":
      return rect(w - d, r, d, col);
  }
}
var REFR_BAND = 0.39;
var REFR_DEPTH = 0.5;
var REFR_LIP_BAND = 0.3;
var REFR_LIP = 5;
var REFR_LIP_POW = 5;
var REFR_WIDTH = 1.1;
var REFR_REACH = 1.5;
var REFR_TILT = 0.2;
var REFR_HEAD = 1 + REFR_TILT;
var REFR_FOLD_DEPTH = REFR_BAND * REFR_WIDTH;
var refrProfile = (q) => {
  const s = 1 - (1 - q) / REFR_WIDTH;
  const u = Math.max(0, Math.min(1, (s - (1 - REFR_BAND)) / REFR_BAND));
  const v = Math.max(0, Math.min(1, (s - (1 - REFR_LIP_BAND)) / REFR_LIP_BAND));
  const d = (REFR_DEPTH * u * u * (3 - 2 * u) + REFR_LIP * Math.pow(v, REFR_LIP_POW)) * REFR_WIDTH;
  if (q <= 1e-6 || d <= 0) return 0;
  const cap = q * REFR_REACH;
  const x = d / cap;
  return cap * x / Math.pow(1 + x ** 4, 0.25);
};
var REFR_PEAK = (() => {
  let m = 1e-6;
  for (let i = 1; i <= 1e3; i++) m = Math.max(m, refrProfile(i / 1e3) / (i / 1e3));
  return m;
})();
var REFR_MAG_PEAK = (() => {
  let m = 1e-6;
  for (let i = 0; i <= 1e3; i++) m = Math.max(m, refrProfile(i / 1e3));
  return m;
})();
var TILT_MULTIPLY = { k1: 2, k2: -1, k3: -1, k4: 1 };
var PACK_Y = "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.5 0 0 0 0.5";
function packedFieldPng(w, h, x, y) {
  const px = new Uint8Array(w * h * 2);
  for (let k = 0; k < w * h; k++) {
    px[2 * k] = clamp255(x[k]);
    px[2 * k + 1] = clamp255(127.5 + y[k] / 2);
  }
  return encodePng(w, h, 2, px);
}
var UNPACK = "1 0 0 0 0  0 0 0 2 -1  0 0 0 0 0  0 0 0 0 1";
var tiltGain = (map, w, h) => {
  const r = Math.max(0.01, Math.min(map.slice.r, w / 2, h / 2));
  const straight = Math.max(0, Math.min(1, (w / 2 - r) / r));
  return REFR_TILT * straight * REFR_MAG_PEAK / (REFR_PEAK * REFR_HEAD);
};
var refractionScale = (map, w, h) => 2 * map.gain * Math.max(0.01, Math.min(map.slice.r, w / 2, h / 2));
var tiltRamp = null;
function buildRefraction(short, radius) {
  const R = Math.max(0.01, Math.min(radius, short / 2));
  const reach = tileReach(R, short);
  const edge = (dir2) => {
    const n = dir2 === "left" || dir2 === "top" ? -1 : 1;
    return edgeTile(dir2, reach, R, (q) => 128 - n * (refrProfile(q) / (REFR_PEAK * REFR_HEAD)) * 127.5);
  };
  const magnitude = (q) => (q > 1e-4 ? refrProfile(q) / q / (REFR_PEAK * REFR_HEAD) : 0) * 255;
  const centers = cornerCenters(R);
  const dir = (axis) => (key) => {
    const c = centers[key][axis === "x" ? 0 : 1];
    return productTile(key, magnitude, axis, (p) => (0.5 + 0.5 * (c - p) / R) * 255, R);
  };
  const tilt = (sign) => (q) => 128 + sign * refrProfile(q) * 127.5 / REFR_MAG_PEAK;
  return {
    slice: { r: R, reach, img: { top: edge("top"), right: edge("right"), bottom: edge("bottom"), left: edge("left") } },
    prod: { x: perCorner(dir("x")), y: perCorner(dir("y")) },
    tilt: {
      r: R,
      reach,
      img: {
        ...perCorner((key) => cornerTile(key, tilt(key === "tl" || key === "bl" ? 1 : -1))),
        top: edgeTile("top", reach, R, tilt(1)),
        bottom: edgeTile("bottom", reach, R, tilt(1)),
        left: edgeTile("left", reach, R, tilt(1)),
        right: edgeTile("right", reach, R, tilt(-1))
      }
    },
    tiltRamp: tiltRamp ??= lineTile(false, (f) => 255 * (1 - f)),
    gain: REFR_PEAK * REFR_HEAD
  };
}
var TILT_GATE = [0.2, 0.6];
function computeRefraction(map, w, h, box, res, resX = res) {
  const R = Math.max(0.01, Math.min(map.slice.r, w / 2, h / 2));
  const S = refractionScale(map, w, h);
  const straight = Math.max(0, Math.min(1, (w / 2 - R) / R));
  const run = w - 2 * R;
  const tw = Math.max(1, Math.round(box.w * resX));
  const th = Math.max(1, Math.round(box.h * res));
  const xs = new Float32Array(tw * th);
  const ys = new Float32Array(tw * th);
  for (let j = 0; j < th; j++) {
    const py = box.y + (j + 0.5) / th * box.h;
    for (let i = 0; i < tw; i++) {
      const px = box.x + (i + 0.5) / tw * box.w;
      const vx = px - Math.max(R, Math.min(w - R, px));
      const vy = py - Math.max(R, Math.min(h - R, py));
      const dist = Math.hypot(vx, vy);
      if (dist < 1e-6) continue;
      const P = refrProfile(Math.min(1, dist / R)) * R;
      if (P === 0) continue;
      const side = run > 1e-6 ? Math.max(-1, Math.min(1, 1 - 2 * (px - R) / run)) : Math.sign(w / 2 - px);
      const g = Math.min(1, Math.max(0, (P / (R * REFR_MAG_PEAK) - TILT_GATE[0]) / (TILT_GATE[1] - TILT_GATE[0])));
      xs[j * tw + i] = -P * vx / dist + REFR_TILT * straight * side * P * g * g * (3 - 2 * g);
      ys[j * tw + i] = -P * vy / dist;
    }
  }
  return { xs, ys, tw, th, S };
}
function refractionField(map, w, h, box, res, resX = res) {
  const { xs, ys, tw, th, S } = computeRefraction(map, w, h, box, res, resX);
  const enc = (d) => Float32Array.from(d, (v) => 255 * (v / S + 0.5));
  return { xy: packedFieldPng(tw, th, enc(xs), enc(ys)) };
}
var FIELD_TEXELS = 96;
var CAP_TEXELS = 14;
var REFL_TEXELS = 32;
function fieldScales(w, h, r) {
  const short = Math.max(1, Math.min(w, h));
  const fine = Math.min(1, Math.max(0.5, FIELD_TEXELS / short));
  const coarse = Math.min(fine, Math.max(fine / 4, CAP_TEXELS / Math.max(1, r)));
  const refl = Math.min(0.5, Math.max(0.25, REFL_TEXELS / short));
  return w >= h ? { x: coarse, y: fine, refl } : { x: fine, y: coarse, refl };
}
var IOR = 1.5;
var R0 = ((1 - IOR) / (1 + IOR)) ** 2;
var SIN_CRIT = 1 / IOR;
var EYE_DIST = 2.6;
var REFL_REACH = 2.6;
var REFL_REACH_MAX = 160;
var RIM_SPAN = 2;
var REFL_CURVE = 1.3;
var REFL_FLOOR = 0.3;
var REFL_INNER = 0.35;
var REFL_FADE = 0.22;
var REFL_BLUR = 1;
var REFL_BLUR_PER_STEP = 1.4;
var dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
var norm3 = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
var refract3 = (i, n, eta) => {
  const cosi = -dot3(i, n);
  const k = 1 - eta * eta * (1 - cosi * cosi);
  if (k < 0) return null;
  const f = eta * cosi - Math.sqrt(k);
  return [eta * i[0] + f * n[0], eta * i[1] + f * n[1], eta * i[2] + f * n[2]];
};
var smootherstep = (t) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * c * (c * (c * 6 - 15) + 10);
};
var WEDGES = 24;
var CSTOPS = 28;
var cornerAt = (i) => 1 - Math.pow(1 - i / CSTOPS, 1.7);
var reflectionScale = (map, w, h) => map.scale / map.slice.r * Math.max(0.01, Math.min(map.slice.r, w / 2, h / 2));
var reflectionPad = (short, avail) => {
  const L = Math.min(REFL_REACH * short, REFL_REACH_MAX);
  const cap = (a) => Math.max(0, Math.floor(Math.min(L, a)));
  return [cap(avail[0]), cap(avail[1]), cap(avail[2]), cap(avail[3])];
};
function buildReflection(width, height, radius, rim, strength, avail) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const R = Math.max(0.01, Math.min(radius, w / 2, h / 2));
  const L = Math.min(REFL_REACH * short, REFL_REACH_MAX);
  const pad = reflectionPad(short, avail);
  if (Math.max(...pad) < 2) return null;
  const [kT, kR, kB, kL] = pad.map((p) => Math.max(0, Math.min(1, p / L)));
  const band = Math.min(Math.max(13 * rim, short * 0.22), short * 0.45);
  const rimW = Math.max(1, 1.8 * rim);
  const ring = Math.min(band * RIM_SPAN, short / 2 - 1);
  const fadeEnd = Math.min(ring, rimW + short * REFL_FADE);
  const eyeZ = EYE_DIST * long;
  const tanT = Math.tan(REFL_CURVE);
  const reachAt = (D) => {
    const u = Math.min(1, Math.max(0, D / ring));
    return REFL_CURVE > 1e-4 ? Math.atan(u * tanT) / REFL_CURVE : u;
  };
  const reflProfile = (q) => L / R * reachAt(R * (1 - q));
  const qMin = Math.max(0.15, 1 - fadeEnd / R - 0.05);
  const cornerMag = (q) => reflProfile(q) / Math.max(q, qMin);
  let peak = 1e-6;
  for (let i = 0; i <= 1e3; i++) peak = Math.max(peak, cornerMag(i / 1e3));
  const weight = (ex, ey, gx, gy, D) => {
    const sN = Math.min(1, D / band);
    const c = 1 - sN;
    const slope = sN >= 1 ? 0 : c / Math.max(0.025, Math.sqrt(1 - c * c));
    const n = norm3([gx * slope, gy * slope, 1]);
    const v = norm3([w / 2 - ex, h / 2 - ey, eyeZ]);
    const cosT = Math.min(1, Math.max(0, dot3(n, v)));
    const fres = R0 + (1 - R0) * Math.pow(1 - cosT, 5);
    let tir = 1;
    const into = refract3([-v[0], -v[1], -v[2]], n, 1 / IOR);
    if (into) tir = Math.min(1, Math.max(0, (Math.hypot(into[0], into[1]) - SIN_CRIT * 0.94) / (SIN_CRIT * 0.12)));
    const inner = D <= rimW ? 0 : fadeEnd > rimW ? REFL_INNER * (1 - smootherstep((D - rimW) / (fadeEnd - rimW))) : 0;
    return Math.min(1, Math.max(REFL_FLOOR, fres + (1 - fres) * tir) * strength * inner);
  };
  const maskReach = Math.max(2, Math.floor(short / 2));
  const edgeDefs = {
    top: { gx: 0, gy: -1, at: (D) => [w / 2, D] },
    bottom: { gx: 0, gy: 1, at: (D) => [w / 2, h - D] },
    left: { gx: -1, gy: 0, at: (D) => [D, h / 2] },
    right: { gx: 1, gy: 0, at: (D) => [w - D, h / 2] }
  };
  const maskEdge = (key) => {
    const def = edgeDefs[key];
    const flip = key === "bottom" || key === "right";
    const vertical = key === "top" || key === "bottom";
    return maskPng(vertical ? 1 : LINE_TEX, vertical ? LINE_TEX : 1, (x, y) => {
      const t = ((vertical ? y : x) + 0.5) / LINE_TEX;
      const f = flip ? 1 - t : t;
      const [ex, ey] = def.at(f * maskReach);
      return weight(ex, ey, def.gx, def.gy, f * maskReach);
    });
  };
  const maskDefs = {
    tl: { a0: Math.PI, cx: R, cy: R, ecx: R, ecy: R },
    tr: { a0: -Math.PI / 2, cx: 0, cy: R, ecx: w - R, ecy: R },
    br: { a0: 0, cx: 0, cy: 0, ecx: w - R, ecy: h - R },
    bl: { a0: Math.PI / 2, cx: R, cy: 0, ecx: R, ecy: h - R }
  };
  const maskCorner = (key) => {
    const def = maskDefs[key];
    const wedgeStops = [];
    for (let k = 0; k < WEDGES; k++) {
      const th = def.a0 + k / (WEDGES - 1) * (Math.PI / 2);
      const gx = Math.cos(th);
      const gy = Math.sin(th);
      const stops = [];
      for (let i = 0; i <= CSTOPS; i++) {
        const rho = cornerAt(i) * R;
        stops.push(weight(def.ecx + gx * rho, def.ecy + gy * rho, gx, gy, R - rho));
      }
      wedgeStops.push(stops);
    }
    const n = Math.max(8, Math.min(128, Math.ceil(R * 2)));
    return maskPng(n, n, (x, y) => {
      const dx = (x + 0.5) / n * R - def.cx;
      const dy = (y + 0.5) / n * R - def.cy;
      const rho = Math.hypot(dx, dy);
      if (rho >= R) return 0;
      let t = Math.atan2(dy, dx) - def.a0;
      t = (t % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      if (t > Math.PI / 2) t = t > Math.PI + Math.PI / 4 ? 0 : Math.PI / 2;
      const stops = wedgeStops[Math.round(t / (Math.PI / 2) * (WEDGES - 1))];
      const f = rho / R;
      let i = 0;
      while (i < CSTOPS - 1 && cornerAt(i + 1) < f) i++;
      const f0 = cornerAt(i);
      const f1 = cornerAt(i + 1);
      const u = f1 > f0 ? Math.min(1, Math.max(0, (f - f0) / (f1 - f0))) : 0;
      return stops[i] + (stops[i + 1] - stops[i]) * u;
    });
  };
  const reach = tileReach(R, short);
  const kEdge = { top: kT, right: kR, bottom: kB, left: kL };
  const offEdge = (key) => {
    const sign = key === "top" || key === "left" ? -1 : 1;
    return edgeTile(key, reach, R, (q) => 128 + sign * (kEdge[key] * reflProfile(q) / peak) * 127.5);
  };
  const centers = cornerCenters(R);
  const offMag = (q) => cornerMag(q) / peak * 255;
  const offDir = (axis) => (key) => {
    const c = centers[key][axis === "x" ? 0 : 1];
    const k = axis === "x" ? key === "tl" || key === "bl" ? kL : kR : key === "tl" || key === "tr" ? kT : kB;
    return productTile(key, offMag, axis, (p) => (0.5 + 0.5 * k * (p - c) / R) * 255, R);
  };
  return {
    slice: { r: R, reach, img: { top: offEdge("top"), right: offEdge("right"), bottom: offEdge("bottom"), left: offEdge("left") } },
    prod: { x: perCorner(offDir("x")), y: perCorner(offDir("y")) },
    mask: {
      r: R,
      reach: maskReach,
      img: {
        ...perCorner(maskCorner),
        top: maskEdge("top"),
        right: maskEdge("right"),
        bottom: maskEdge("bottom"),
        left: maskEdge("left")
      }
    },
    pad,
    scale: 2 * peak * R,
    blur: Math.max(REFL_BLUR, 2 * peak * R / 255 * REFL_BLUR_PER_STEP)
  };
}
var ARC_PEAK = 45;
var ARC_SHAPE = 0.4;
var ARC_STEP = 3;
var ARC_CACHE = /* @__PURE__ */ new Map();
function buildBevelArcs(width, height) {
  const w = Math.round(width);
  const h = Math.round(height);
  const key = `${w}:${h}`;
  const hit = ARC_CACHE.get(key);
  if (hit) return hit;
  const ax = 1 / Math.pow(Math.max(1, w) / 2, ARC_SHAPE);
  const by = 1 / Math.pow(Math.max(1, h) / 2, ARC_SHAPE);
  const glint = (deg) => {
    const r = deg * Math.PI / 180;
    const n = (Math.atan2(Math.sin(r) * ax, Math.cos(r) * by) * 180 / Math.PI + 360) % 360;
    return (1 + Math.cos(2 * (n - ARC_PEAK) * Math.PI / 180)) / 2;
  };
  const stop = (v, deg) => `${v >= 0.9995 ? "#000" : v <= 5e-4 ? "transparent" : `rgba(0,0,0,${+v.toFixed(3)})`} ${deg}deg`;
  const build = (fn) => {
    const parts = ["from 0deg"];
    for (let deg = 0; deg <= 360; deg += ARC_STEP) parts.push(stop(fn(deg), deg));
    return `conic-gradient(${parts.join(",")})`;
  };
  const res = { glint: build(glint), rim: build((deg) => 1 - glint(deg)) };
  if (ARC_CACHE.size >= 48) ARC_CACHE.delete(ARC_CACHE.keys().next().value);
  ARC_CACHE.set(key, res);
  return res;
}

// ../../../../tmp/css-liquid-glass/src/glass/liquid-glass.ts
var BAKE_SLACK_DOWN = 12;
var BAKE_SLACK_UP = 3;
var BAKE_SETTLE_MS = 650;
var AVAIL_STEP = 8;
var REGION = 2;
var TICK_GAP_MS = [13, 25, 50];
var TICK_HOLD_MS = 600;
var TICK_PAUSE_MS = 120;
var FIELD_SCALE = 0.5;
var PROMOTE_DEFAULT = "main";
var REFR_CACHE = /* @__PURE__ */ new Map();
function cachedRefraction(short, radius) {
  const key = `${short}|${radius}`;
  let map = REFR_CACHE.get(key);
  if (!map) {
    map = buildRefraction(short, radius);
    if (REFR_CACHE.size >= 96) REFR_CACHE.delete(REFR_CACHE.keys().next().value);
    REFR_CACHE.set(key, map);
  }
  return map;
}
var SVG_BACKDROP = typeof navigator !== "undefined" && "userAgentData" in navigator;
var supportsRefraction = SVG_BACKDROP;
var SVG_NS = "http://www.w3.org/2000/svg";
function el(parent, tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent.appendChild(node);
  return node;
}
function layer(parent, cls) {
  const node = document.createElement("span");
  node.className = cls;
  node.setAttribute("aria-hidden", "true");
  parent.appendChild(node);
  return node;
}
var setAttr = (node, name, value) => {
  const next = String(value);
  if (node.getAttribute(name) !== next) node.setAttribute(name, next);
};
var setRect = (node, r) => {
  setAttr(node, "x", r.x);
  setAttr(node, "y", r.y);
  setAttr(node, "width", r.w);
  setAttr(node, "height", r.h);
};
var setStyle = (node, name, value) => {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
};
var setBackdrop = (node, value) => {
  setStyle(node, "backdrop-filter", value);
  setStyle(node, "-webkit-backdrop-filter", value);
};
function buildField(filter, p) {
  el(filter, "feFlood", { "flood-color": "rgb(128,128,128)", result: `${p}base` });
  const edges = {};
  for (const slot of EDGES)
    edges[slot] = el(filter, "feImage", { preserveAspectRatio: "none", result: `${p}${slot}` });
  const corners = {};
  for (const axis of ["x", "y"]) {
    for (const c of CORNERS)
      corners[`${axis}${c}`] = el(filter, "feImage", { preserveAspectRatio: "none", result: `${p}c${axis}${c}` });
    const merge = el(filter, "feMerge", { result: `${p}${axis}` });
    el(merge, "feMergeNode", { in: `${p}base` });
    for (const c of CORNERS) el(merge, "feMergeNode", { in: `${p}c${axis}${c}` });
    for (const slot of axis === "x" ? ["left", "right"] : ["top", "bottom"]) el(merge, "feMergeNode", { in: `${p}${slot}` });
  }
  return { edges, corners };
}
function packField(filter, x, y, out) {
  el(filter, "feColorMatrix", { in: y, type: "matrix", values: PACK_Y, result: `${out}ya` });
  el(filter, "feComposite", { in: x, in2: `${out}ya`, operator: "in", result: `${out}xy` });
  el(filter, "feColorMatrix", { in: `${out}xy`, type: "matrix", values: UNPACK, result: out });
  return el(filter, "feDisplacementMap", {
    in: "SourceGraphic",
    in2: out,
    xChannelSelector: "R",
    yChannelSelector: "G",
    result: "bent"
  });
}
function setFieldImages(field, map) {
  for (const slot of EDGES) setAttr(field.edges[slot], "href", map.slice.img[slot]);
  for (const axis of ["x", "y"])
    for (const c of CORNERS) setAttr(field.corners[`${axis}${c}`], "href", map.prod[axis][c]);
}
function layField(field, tiles, w, h, ox = 0, oy = 0) {
  for (const slot of EDGES) setRect(field.edges[slot], sliceRect(slot, w, h, tiles.r, tiles.reach, ox, oy));
  for (const c of CORNERS) {
    const rect = sliceRect(c, w, h, tiles.r, tiles.reach, ox, oy);
    setRect(field.corners[`x${c}`], rect);
    setRect(field.corners[`y${c}`], rect);
  }
}
var boxOf = (f) => ({
  x: +f.getAttribute("x"),
  y: +f.getAttribute("y"),
  width: +f.getAttribute("width"),
  height: +f.getAttribute("height")
});
async function renderFilter(f, box, scale) {
  const { x, y, width: w, height: h } = box;
  f.id = "f";
  const svg = (
    // Rendered at full size and scaled down by the canvas: where two tiles
    // meet, a seam rendered small would stay as a visible line.
    `<svg xmlns="${SVG_NS}" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}">${f.outerHTML}<rect x="${x}" y="${y}" width="${w}" height="${h}" filter="url(#f)"/></svg>`
  );
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return decoded(canvas.toDataURL("image/png"));
}
async function decoded(url) {
  await new Promise((resolve, reject) => {
    const check = new Image();
    check.onload = resolve;
    check.onerror = reject;
    check.src = url;
  });
  return url;
}
function renderField(live, out, cut, box, scale) {
  const f = live.cloneNode(true);
  const from = f.querySelector(`[result="${cut}"]`);
  while (from?.nextSibling) from.nextSibling.remove();
  from?.remove();
  el(el(f, "feMerge"), "feMergeNode", { in: out });
  return renderFilter(f, box, scale);
}
async function packImages(xUrl, yUrl) {
  const read = async (url) => {
    const img = new Image();
    img.src = url;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    return { w: c.width, h: c.height, v: Uint8Array.from({ length: c.width * c.height }, (_, k) => d[4 * k]) };
  };
  const [x, y] = await Promise.all([read(xUrl), read(yUrl)]);
  return decoded(packedFieldPng(x.w, x.h, x.v, y.v));
}
var image = (attrs) => {
  const node = document.createElementNS(SVG_NS, "feImage");
  for (const [k, v] of Object.entries({ preserveAspectRatio: "none", ...attrs })) node.setAttribute(k, String(v));
  return node;
};
function renderMask(live, mask) {
  const names = [...mask.parts, mask.result];
  const f = live.cloneNode(true);
  for (const n of [...f.children]) if (!names.includes(n.getAttribute("result") ?? "")) n.remove();
  return renderFilter(f, mask.box, mask.scale);
}
async function bakeFilter(live, xOut, yOut, cut, scale, { box = boxOf(live), mask, fields } = {}) {
  const isMask = (n) => !!mask && [...mask.parts, mask.result].includes(n.getAttribute("result") ?? "");
  const [xyUrl, maskUrl] = await Promise.all([
    fields ? decoded(fields.xy) : Promise.all([renderField(live, xOut, cut, box, scale), renderField(live, yOut, cut, box, scale)]).then(([x, y]) => packImages(x, y)),
    mask ? renderMask(live, mask) : ""
  ]);
  const f = live.cloneNode(true);
  f.id = `${live.id}-baked`;
  const from = f.querySelector(`[result="${cut}"]`);
  while (from.previousSibling) from.previousSibling.remove();
  const packed = from.nextElementSibling.getAttribute("result");
  from.nextElementSibling.remove();
  from.replaceWith(image({ ...box, result: packed, href: xyUrl }));
  if (mask) {
    const parts = [...f.children].filter(isMask);
    parts[parts.length - 1].after(image({ ...mask.box, result: mask.result, href: maskUrl }));
    for (const n of parts) n.remove();
  }
  document.getElementById(f.id)?.remove();
  live.after(f);
  return f.id;
}
function ringMask(w, h, r, rimW, fade, dpr) {
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(h * dpr));
  const sx = W / w;
  const sy = H / h;
  const R = Math.min(r, w / 2, h / 2);
  const d = Math.max(0.01, Math.min(fade, R));
  const s = Math.min(1, rimW / d);
  const bx = Math.min(Math.floor(W / 2), Math.round(R * sx));
  const by = Math.min(Math.floor(H / 2), Math.round(R * sy));
  const hx = Math.floor(W / 2);
  const hy = Math.floor(H / 2);
  const stops = (a, b) => `<stop offset="${a}" stop-opacity="${a === s ? 1 : 0}"/><stop offset="${b}" stop-opacity="${b === s ? 1 : 0}"/>`;
  const linear = (id, x1, y1, x2, y2) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops(s, 1)}</linearGradient>`;
  const radial = (id, cx, cy) => `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${R * sx}" gradientTransform="translate(${cx} ${cy}) scale(1 ${sy / sx}) translate(${-cx} ${-cy})"><stop offset="${(R - d) / R}" stop-opacity="0"/><stop offset="${(R - Math.min(rimW, d)) / R}" stop-opacity="1"/></radialGradient>`;
  const rect = (x, y, rw, rh, fill) => rw > 0 && rh > 0 ? `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="url(#${fill})"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges"><defs>` + linear("t", 0, 0, 0, d * sy) + linear("b", 0, H, 0, H - d * sy) + linear("l", 0, 0, d * sx, 0) + linear("r", W, 0, W - d * sx, 0) + radial("ctl", R * sx, R * sy) + radial("ctr", W - R * sx, R * sy) + radial("cbr", W - R * sx, H - R * sy) + radial("cbl", R * sx, H - R * sy) + `</defs>` + rect(bx, 0, W - 2 * bx, hy, "t") + rect(bx, hy, W - 2 * bx, H - hy, "b") + rect(0, by, hx, H - 2 * by, "l") + rect(hx, by, W - hx, H - 2 * by, "r") + rect(0, 0, bx, by, "ctl") + rect(W - bx, 0, bx, by, "ctr") + rect(W - bx, H - by, bx, by, "cbr") + rect(0, H - by, bx, by, "cbl") + `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
function ringWidths(layerEl) {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:0;top:0;width:var(--w);height:var(--d);visibility:hidden";
  layerEl.append(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  return { rimW: r.width, fade: r.height };
}
var instances = 0;
function createLiquidGlass(host, options = {}) {
  const {
    radius = 30,
    rim = 1.3,
    blur = 2.5,
    saturate = 1.1,
    reflect = true,
    reflectStrength = 2.5,
    promote = true
  } = options;
  const uid = ++instances;
  if (promote && !document.getElementById("lg-promote")) {
    const st = document.createElement("style");
    st.id = "lg-promote";
    st.textContent = `${promote === true ? PROMOTE_DEFAULT : promote} { will-change: transform }`;
    document.head.append(st);
  }
  const refractId = `lg-refract-${uid}`;
  const reflectId = `lg-reflect-${uid}`;
  host.classList.add("lg-host");
  host.style.borderRadius = `${radius}px`;
  const root = document.createDocumentFragment();
  const defs = el(root, "svg", { class: "lg-defs", width: 0, height: 0, "aria-hidden": "true" });
  const refrFilter = el(defs, "filter", {
    id: refractId,
    filterUnits: "userSpaceOnUse",
    "color-interpolation-filters": "sRGB",
    x: -REGION,
    y: -REGION
  });
  const refrField = buildField(refrFilter, "r");
  el(refrFilter, "feFlood", { "flood-color": "rgb(128,128,128)", result: "tbase" });
  const tiltTiles = {};
  for (const slot of SLOTS) tiltTiles[slot] = el(refrFilter, "feImage", { preserveAspectRatio: "none", result: `t${slot}` });
  const tmag = el(refrFilter, "feMerge", { result: "tmag" });
  el(tmag, "feMergeNode", { in: "tbase" });
  for (const slot of SLOTS) el(tmag, "feMergeNode", { in: `t${slot}` });
  el(refrFilter, "feFlood", { "flood-color": "rgb(255,255,255)", result: "sbase" });
  const tiltRamp2 = el(refrFilter, "feImage", { preserveAspectRatio: "none", y: 0, result: "sramp" });
  const sfield = el(refrFilter, "feMerge", { result: "sfield" });
  el(sfield, "feMergeNode", { in: "sbase" });
  el(sfield, "feMergeNode", { in: "sramp" });
  el(refrFilter, "feComposite", { in: "tmag", in2: "sfield", operator: "arithmetic", ...TILT_MULTIPLY, result: "tvec" });
  const tiltAdd = el(refrFilter, "feComposite", { in: "rx", in2: "tvec", operator: "arithmetic", k1: 0, k2: 1, result: "rxt" });
  const refrDisp = packField(refrFilter, "rxt", "ry", "rmap");
  const reflFilter = el(defs, "filter", {
    id: reflectId,
    filterUnits: "userSpaceOnUse",
    "color-interpolation-filters": "sRGB",
    x: -REGION,
    y: -REGION
  });
  const reflField = buildField(reflFilter, "f");
  const reflTailFrom = reflFilter.children.length;
  const reflDisp = packField(reflFilter, "fx", "fy", "fmap");
  const reflBlur = el(reflFilter, "feGaussianBlur", { in: "bent", result: "fsoft" });
  const reflMask = {};
  for (const slot of SLOTS) reflMask[slot] = el(reflFilter, "feImage", { preserveAspectRatio: "none", result: `fm${slot}` });
  const reflMaskMerge = el(reflFilter, "feMerge", { result: "fmask" });
  for (const slot of SLOTS) el(reflMaskMerge, "feMergeNode", { in: `fm${slot}` });
  el(reflFilter, "feComposite", { in: "fsoft", in2: "fmask", operator: "in" });
  const reflectLayer = layer(root, "lg-layer lg-reflect");
  reflectLayer.hidden = true;
  const causticWrap = layer(root, "lg-layer lg-caustic");
  layer(causticWrap, "lg-caustic-ring");
  const pane = layer(root, "lg-layer lg-pane");
  const fold = layer(root, "lg-layer lg-edge lg-fold");
  const glint = layer(root, "lg-layer lg-edge lg-glint");
  const rimLayer = layer(root, "lg-layer lg-edge lg-rim");
  host.prepend(root);
  const makeCover = () => {
    const c = document.createElement("div");
    c.className = "lg-cover";
    c.setAttribute("aria-hidden", "true");
    c.style.position = "absolute";
    layer(c, "lg-layer lg-edge lg-spec");
    layer(c, "lg-layer lg-underlay");
    return c;
  };
  const cover = makeCover();
  const covers = [cover];
  host.after(cover);
  const tick = document.createElement("span");
  tick.className = "lg-tick";
  tick.setAttribute("aria-hidden", "true");
  tick.style.position = "absolute";
  host.before(tick);
  const place = () => {
    const cs = getComputedStyle(host);
    const fixed = cs.position === "fixed";
    const r = host.getBoundingClientRect();
    const o = fixed ? { left: 0, top: 0 } : (host.offsetParent ?? document.body).getBoundingClientRect();
    const [tx = 0, ty = 0] = cs.translate === "none" ? [] : cs.translate.split(" ").map(parseFloat);
    for (const el2 of [tick, ...covers]) {
      setStyle(el2, "position", fixed ? "fixed" : "absolute");
      setStyle(el2, "left", `${r.left - o.left - tx}px`);
      setStyle(el2, "top", `${r.top - o.top - ty}px`);
      setStyle(el2, "width", `${r.width}px`);
      setStyle(el2, "height", `${r.height}px`);
    }
    for (const c of covers) {
      setStyle(c, "z-index", cs.zIndex);
      setStyle(c, "border-radius", cs.borderRadius);
      for (const name of ["--lg-r", "--lg-s", "--lg-rim-w", "--lg-rim-fade"]) {
        const v = cs.getPropertyValue(name);
        if (v) setStyle(c, name, v);
        else c.style.removeProperty(name);
      }
    }
  };
  const bevel = (prop, exposure, sat) => `brightness(var(--lg-${prop}-exp, ${exposure})) saturate(var(--lg-${prop}-sat, ${sat}))`;
  setBackdrop(fold, "brightness(var(--lg-fold-exp, 1.08)) saturate(var(--lg-fold-sat, 1.3))");
  fold.style.setProperty("--lg-fold-k", String(REFR_FOLD_DEPTH));
  setBackdrop(glint, bevel("glint", 1.35, 3.1));
  setBackdrop(rimLayer, bevel("rim", 0.84, 2.2));
  const frost = `${blur > 0 ? ` blur(${blur}px)` : ""} saturate(${saturate})`;
  const setPane = (v) => setBackdrop(pane, v);
  const setRefl = (v) => setBackdrop(reflectLayer, v);
  setPane(frost.trim());
  let w = 0;
  let h = 0;
  let baked = 0;
  let refr = null;
  let refl = null;
  let reflSize = { w: 0, h: 0 };
  let avail = null;
  let bakeTimer = 0;
  let viewTimer = 0;
  let fieldTimer = 0;
  let refrKey = "";
  let reflKey = "";
  let pendRefr = false;
  let pendRefl = false;
  let bakedOnce = false;
  let lastSpot = "";
  const measureAvail = () => {
    const r = host.getBoundingClientRect();
    const q = (v) => Math.max(0, Math.floor(v / AVAIL_STEP) * AVAIL_STEP);
    return [q(r.top), q(innerWidth - r.right), q(innerHeight - r.bottom), q(r.left)];
  };
  const sync = () => {
    host.style.setProperty("--lg-r", `${Math.max(0.01, Math.min(radius, w / 2, h / 2))}px`);
    if (refr) {
      layField(refrField, refr.slice, w, h);
      for (const slot of SLOTS) setRect(tiltTiles[slot], sliceRect(slot, w, h, refr.tilt.r, refr.tilt.reach));
      const r = Math.max(0.01, Math.min(refr.slice.r, w / 2, h / 2));
      setAttr(tiltRamp2, "x", r);
      setAttr(tiltRamp2, "width", Math.max(0.01, w - 2 * r));
      setAttr(tiltRamp2, "height", h);
      const g = tiltGain(refr, w, h);
      setAttr(tiltAdd, "k3", g);
      setAttr(tiltAdd, "k4", -g / 2);
      setAttr(refrDisp, "scale", refractionScale(refr, w, h));
      setAttr(refrFilter, "width", w + REGION * 2);
      setAttr(refrFilter, "height", h + REGION * 2);
    }
    if (refl) {
      const [pt, pr, pb, pl] = refl.pad;
      layField(reflField, refl.slice, w, h, pl, pt);
      setAttr(reflDisp, "scale", reflectionScale(refl, w, h));
      setAttr(reflFilter, "width", w + pl + pr + REGION * 2);
      setAttr(reflFilter, "height", h + pt + pb + REGION * 2);
      const m = Math.ceil(3 * refl.blur) + REGION;
      for (let i = reflTailFrom; i < reflFilter.children.length; i++)
        setRect(reflFilter.children[i], { x: pl - m, y: pt - m, w: w + 2 * m, h: h + 2 * m });
      for (const slot of SLOTS) {
        const r = sliceRect(slot, w, h, refl.mask.r, refl.mask.reach, pl, pt);
        setRect(reflMask[slot], r.w < 0.5 || r.h < 0.5 ? { ...r, w: 0, h: 0 } : r);
      }
    }
    place();
    const arcs = buildBevelArcs(w, h);
    setStyle(glint, "--lg-arc-glint", arcs.glint);
    for (const c of covers) setStyle(c.querySelector(".lg-spec"), "--lg-arc-glint", arcs.glint);
    setStyle(rimLayer, "--lg-arc-rim", arcs.rim);
    scheduleFields();
  };
  let ringKey = "";
  const edgeLayers = () => [fold, glint, rimLayer, ...covers.map((c) => c.querySelector(".lg-spec"))];
  const clearRings = () => {
    if (!ringKey) return;
    ringKey = "";
    for (const e of edgeLayers()) e.removeAttribute("data-ring");
  };
  const applyRings = async () => {
    const key = `${w}x${h}@${devicePixelRatio}`;
    if (key === ringKey) return;
    const r = Math.max(0.01, Math.min(radius, w / 2, h / 2));
    const jobs = edgeLayers().map(async (e) => {
      const { rimW, fade } = ringWidths(e);
      return { e, url: await decoded(ringMask(w, h, r, rimW, fade, devicePixelRatio)) };
    });
    const done = await Promise.all(jobs);
    if (`${w}x${h}@${devicePixelRatio}` !== key) return;
    ringKey = key;
    for (const { e, url } of done) {
      setStyle(e, "--lg-ring", `url("${url}")`);
      e.setAttribute("data-ring", "");
    }
  };
  const scheduleFields = () => {
    if (!refr) return;
    const rKey = `${w}x${h}`;
    const fKey = refl ? `${rKey}:${refl.pad.join(",")}` : "";
    if (rKey !== refrKey) {
      refrKey = rKey;
      pendRefr = true;
      setPane(`url(#${refractId})${frost}`);
      if (!ringKey.startsWith(`${rKey}@`)) clearRings();
    }
    if (fKey !== reflKey) {
      reflKey = fKey;
      pendRefl = true;
      if (refl) setRefl(`url(#${reflectId})`);
    }
    if (!pendRefr && !pendRefl) return;
    clearTimeout(fieldTimer);
    fieldTimer = window.setTimeout(async () => {
      const doRefr = pendRefr;
      const doRefl = pendRefl && !!refl;
      pendRefr = pendRefl = false;
      const field = refr;
      const map = refl;
      const res = fieldScales(w, h, Math.min(field.slice.r, w / 2, h / 2));
      try {
        if (doRefr) {
          const region = { x: -REGION, y: -REGION, width: w + 2 * REGION, height: h + 2 * REGION };
          const refrBaked = await bakeFilter(refrFilter, "rxt", "ry", "rmapya", res.y, {
            box: region,
            fields: refractionField(field, w, h, { x: region.x, y: region.y, w: region.width, h: region.height }, res.y, res.x)
          });
          if (rKey === refrKey) {
            setPane(`url(#${refrBaked})${frost}`);
            bakedOnce = true;
          }
        }
        if (doRefl && map) {
          const box = { x: map.pad[3], y: map.pad[0], width: w, height: h };
          const m = Math.ceil(3 * map.blur) + REGION;
          const mask = { result: "fmask", parts: SLOTS.map((slot) => `fm${slot}`), box, scale: FIELD_SCALE };
          const reflBaked = await bakeFilter(reflFilter, "fx", "fy", "fmapya", res.refl, {
            box: { x: box.x - m, y: box.y - m, width: box.width + 2 * m, height: box.height + 2 * m },
            mask
          });
          if (fKey === reflKey) setRefl(`url(#${reflBaked})`);
        }
        await applyRings();
      } catch {
      }
    }, bakedOnce ? 300 : 0);
  };
  const rebuildReflection = () => {
    refl = reflect && avail ? buildReflection(reflSize.w, reflSize.h, radius, rim, reflectStrength, avail) : null;
    reflKey = "";
    reflectLayer.hidden = !refl;
    if (!refl) return;
    setFieldImages(reflField, refl);
    setAttr(reflBlur, "stdDeviation", refl.blur);
    const [pt, pr, pb, pl] = refl.pad;
    const clip = `inset(${pt}px ${pr}px ${pb}px ${pl}px round var(--lg-r))`;
    reflectLayer.style.inset = `${-pt}px ${-pr}px ${-pb}px ${-pl}px`;
    setStyle(reflectLayer, "clip-path", clip);
    setStyle(reflectLayer, "-webkit-clip-path", clip);
    for (const slot of SLOTS) setAttr(reflMask[slot], "href", refl.mask.img[slot]);
    setRefl(`url(#${reflectId})`);
  };
  const bake = (short) => {
    baked = short;
    refrKey = reflKey = "";
    refr = cachedRefraction(short, radius);
    setFieldImages(refrField, refr);
    for (const slot of SLOTS) setAttr(tiltTiles[slot], "href", refr.tilt.img[slot]);
    setAttr(tiltRamp2, "href", refr.tiltRamp);
    reflSize = { w, h };
    rebuildReflection();
    setPane(`url(#${refractId})${frost}`);
  };
  const onResize = () => {
    const nw = Math.round(host.clientWidth);
    const nh = Math.round(host.clientHeight);
    if (nw < 8 || nh < 8 || nw === w && nh === h) return;
    w = nw;
    h = nh;
    const s = Math.min(w, h);
    if (!SVG_BACKDROP) {
    } else if (!refr) {
      avail = measureAvail();
      bake(s);
    } else if (s > baked + BAKE_SLACK_UP) {
      clearTimeout(bakeTimer);
      bake(s);
    } else if (baked - s > BAKE_SLACK_DOWN) {
      clearTimeout(bakeTimer);
      bakeTimer = window.setTimeout(() => {
        const settled = Math.min(Math.round(host.clientWidth), Math.round(host.clientHeight));
        if (Math.abs(settled - s) <= 1 && baked - settled > BAKE_SLACK_DOWN) {
          bake(settled);
          sync();
        }
      }, BAKE_SETTLE_MS);
    } else {
      clearTimeout(bakeTimer);
    }
    sync();
  };
  const onView = () => {
    clearTimeout(viewTimer);
    viewTimer = window.setTimeout(function check() {
      const r = host.getBoundingClientRect();
      const spot = `${Math.round(r.top)}:${Math.round(r.left)}`;
      if (spot !== lastSpot) {
        lastSpot = spot;
        viewTimer = window.setTimeout(check, 120);
        return;
      }
      place();
      const next = measureAvail();
      if (!refr) return;
      const short = Math.min(reflSize.w, reflSize.h);
      const before = avail && reflectionPad(short, avail);
      avail = next;
      if (!before || reflectionPad(short, next).some((v, i) => v !== before[i])) {
        rebuildReflection();
        sync();
      }
    }, 220);
  };
  let tickAt = -Infinity;
  let tickReq = 0;
  let frameAt = -Infinity;
  let frameMs = 50;
  let gap = TICK_GAP_MS[0];
  let gapUntil = -Infinity;
  const applyTick = (now) => {
    tickReq = 0;
    const dt = now - frameAt;
    frameAt = now;
    if (dt < TICK_PAUSE_MS) {
      frameMs = Math.min(Math.max(4, dt), frameMs * 1.02);
      const level = dt >= 4 * frameMs + 2 ? 2 : dt >= 2 * frameMs + 2 ? 1 : 0;
      if (level) {
        gap = Math.max(gap, TICK_GAP_MS[level]);
        gapUntil = now + TICK_HOLD_MS;
      }
    }
    if (now > gapUntil) gap = TICK_GAP_MS[0];
    if (now - tickAt < gap) {
      tickReq = requestAnimationFrame(applyTick);
      return;
    }
    tickAt = now;
    tick.toggleAttribute("data-tick");
  };
  const refresh = () => {
    if (!tickReq) tickReq = requestAnimationFrame(applyTick);
  };
  const onScroll = () => {
    if (refl) refresh();
    onView();
  };
  const ro = new ResizeObserver(onResize);
  ro.observe(host);
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onView, { passive: true });
  onResize();
  onView();
  return {
    /**
     * Scrolling is handled already. Content that changes next to the glass on
     * its own (a playing video) still freezes in the reflection; call this
     * for every frame of such content to keep it live.
     */
    refresh,
    /**
     * Re-places the fill under the glass and the covers over it after the
     * host moved without changing size, for example from fixed to absolute.
     */
    update() {
      place();
      onView();
    },
    /**
     * A further cover with a fixed tuning, appended to `parent`; hides the
     * built-in one. Make one light and one dark cover and crossfade them with
     * opacity (on a will-change: opacity layer): the compositor blends them
     * without repainting anything. Positioned like the host, so with a host
     * that is not fixed, `parent` must be its parent.
     */
    addCover(parent, dark) {
      const c = makeCover();
      c.style.setProperty("--lg-dark", String(dark));
      parent.append(c);
      covers.push(c);
      cover.hidden = true;
      place();
      sync();
      return c;
    },
    destroy() {
      ro.disconnect();
      clearTimeout(bakeTimer);
      clearTimeout(viewTimer);
      clearTimeout(fieldTimer);
      cancelAnimationFrame(tickReq);
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onView);
      host.querySelectorAll(":scope > .lg-layer, :scope > .lg-defs").forEach((n) => n.remove());
      tick.remove();
      for (const c of covers) c.remove();
      host.classList.remove("lg-host");
    }
  };
}
export {
  createLiquidGlass,
  supportsRefraction
};
