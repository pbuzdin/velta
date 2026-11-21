// Curved matte glass for #main-composer.
// The plate is a rounded slab: steep at the rim, flat in the middle.
// Red/green of the map are the refraction offset (128 = none). A short
// blur plus stable grain on the flat face is the matte, not the lens.
// Chromium paints this through backdrop-filter: url(#velta-glass).
// Engines that drop url() leave the composer opaque.

const IOR = 1.5;
const BEVEL = 0.46;
const RADIUS = 22;

function clamp8(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

function hash(x, y) {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function sdRoundRect(px, py, hw, hh, r) {
  const x = Math.abs(px) - (hw - r);
  const y = Math.abs(py) - (hh - r);
  return Math.hypot(Math.max(x, 0), Math.max(y, 0)) + Math.min(Math.max(x, y), 0) - r;
}

function sdfGrad(px, py, hw, hh, r) {
  const e = 0.75;
  const dx = sdRoundRect(px + e, py, hw, hh, r) - sdRoundRect(px - e, py, hw, hh, r);
  const dy = sdRoundRect(px, py + e, hw, hh, r) - sdRoundRect(px, py - e, hw, hh, r);
  const l = Math.hypot(dx, dy) || 1;
  return { nx: dx / l, ny: dy / l };
}

// t = 0 on the rim, 1 where the face has become flat.
function profile(t) {
  const u = 1 - Math.min(1, Math.max(0, t));
  const z = Math.sqrt(Math.max(0, 1 - u * u));
  return { height: z, slope: z < 1e-3 ? 80 : u / z };
}

function refractionOffset(slope) {
  const thetaI = Math.atan(slope);
  const s = Math.sin(thetaI) / IOR;
  if (s >= 1) return Math.tan(thetaI);
  return Math.tan(thetaI - Math.asin(s));
}

// RGBA displacement map. Outside the rounded slab is neutral.
export function glassMap(w, h, radius) {
  w = Math.max(1, w | 0);
  h = Math.max(1, h | 0);
  const data = new Uint8ClampedArray(w * h * 4);
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const bevel = Math.max(8, Math.min(w, h) * BEVEL);
  const maxOff = refractionOffset(profile(0).slope) || 1;
  const hw = w / 2;
  const hh = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const px = x + 0.5 - hw;
      const py = y + 0.5 - hh;
      const dist = sdRoundRect(px, py, hw, hh, r);
      data[i + 3] = 255;
      if (dist > 0) {
        data[i] = 128;
        data[i + 1] = 128;
        continue;
      }
      const p = profile(Math.min(1, -dist / bevel));
      const amount = refractionOffset(p.slope) / maxOff;
      const g = sdfGrad(px, py, hw, hh, r);
      let dx = g.nx * amount;
      let dy = g.ny * amount;
      if (amount < 0.05) {
        dx += (hash(x, y) - 0.5) * 0.05;
        dy += (hash(y, x) - 0.5) * 0.05;
      }
      // Outward normal, so subtract it: the sample comes from further inside.
      data[i] = clamp8(128 - dx * 127);
      data[i + 1] = clamp8(128 - dy * 127);
      data[i + 2] = clamp8(p.height * 255);
    }
  }
  return data;
}

const GLASS_KEY = "velta-glass-composer";

// Absent or anything but "1" is off. Same switch shape as the other extras.
export function glassComposerWanted() {
  try { return localStorage.getItem(GLASS_KEY) === "1"; } catch { return false; }
}

let lensOk;
function lensSupported() {
  if (lensOk != null) return lensOk;
  // WebView2 and Android WebView paint backdrop-filter: url(#svg).
  // WebKit keeps the property and then drops the filter, which would
  // leave a see-through bar with no lens.
  const ua = globalThis.navigator?.userAgent || "";
  if (!/Chrome\/|Chromium\/|Edg\//.test(ua)) return (lensOk = false);
  const el = document.createElement("div");
  el.style.backdropFilter = 'url("#velta-glass")';
  return (lensOk = el.style.backdropFilter.includes("url"));
}

function reducedTransparency() {
  return !!globalThis.matchMedia?.("(prefers-reduced-transparency: reduce)").matches;
}

export function glassComposerAvailable() {
  return lensSupported() && !reducedTransparency();
}

const FILTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" style="position:absolute">
  <filter id="velta-glass" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">
    <feImage id="velta-glass-map" href="" result="map" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none"/>
    <feDisplacementMap in="SourceGraphic" in2="map" scale="72" xChannelSelector="R" yChannelSelector="G"/>
    <feGaussianBlur stdDeviation="4"/>
  </filter>
</svg>`;

function paintMap(feImage, cssW, cssH) {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.putImageData(new ImageData(glassMap(w, h, RADIUS * dpr), w, h), 0, 0);
  // A data URL on feImage itself. A same-document <image> reference
  // stays blank inside a backdrop filter.
  feImage.setAttribute("href", canvas.toDataURL("image/png"));
}

let hooked = false;

export function installGlassComposer(doc = globalThis.document) {
  if (!doc || hooked) return;
  hooked = true;
  let started = false;
  let kick = () => {};
  const apply = () => {
    const bar = doc.getElementById("main-composer");
    const view = doc.getElementById("chat-view");
    if (!bar || !view) return;
    if (!glassComposerWanted() || !glassComposerAvailable()) {
      bar.classList.remove("glass-on");
      return;
    }
    if (!started) {
      started = true;
      const holder = doc.createElement("div");
      holder.innerHTML = FILTER_SVG;
      doc.body.appendChild(holder.firstElementChild);
      const img = doc.getElementById("velta-glass-map");
      let painted = "";
      const plate = () => {
        const h = bar.offsetHeight;
        if (h < 8) return;
        view.style.setProperty("--composer-glass", h + "px");
        const cs = getComputedStyle(bar, "::before");
        const insetY = (parseFloat(cs.top) || 0) + (parseFloat(cs.bottom) || 0);
        const insetX = (parseFloat(cs.left) || 0) + (parseFloat(cs.right) || 0);
        const key = `${Math.round(bar.offsetWidth - insetX)}x${Math.round(h - insetY)}`;
        if (key === painted) return;
        painted = key;
        paintMap(img, Math.max(1, bar.offsetWidth - insetX), Math.max(1, h - insetY));
      };
      let scheduled = 0;
      kick = () => {
        if (scheduled) return;
        scheduled = requestAnimationFrame(() => { scheduled = 0; plate(); });
      };
      new ResizeObserver(kick).observe(bar);
    }
    bar.classList.add("glass-on");
    kick();
  };
  globalThis.addEventListener?.("velta-glass-pref", apply);
  apply();
}
