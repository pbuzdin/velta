// Composer video preview (attachment strip): the first-frame poster probe,
// the play label, the wiring into the strip and the lightbox, and WCAG AA for
// every label on the strip in dark / light / brutal and custom accents.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { firstFrameTime, posterSize, playLabel, probeVideo } from "../app/js/composer-video.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("first-frame seek and poster size", () => {
  assert.equal(firstFrameTime(0), 0);
  assert.equal(firstFrameTime(NaN), 0);
  assert.equal(firstFrameTime(Infinity), 0);
  assert.equal(firstFrameTime(60), 0.1);
  assert.equal(firstFrameTime(0.1), 0.05);
  assert.deepEqual(posterSize(1920, 1080, 320, 1), { w: 320, h: 180 });
  assert.deepEqual(posterSize(1080, 1920, 320, 2), { w: 360, h: 640 });
  assert.deepEqual(posterSize(100, 50, 320, 1), { w: 100, h: 50 });
  assert.equal(posterSize(0, 0), null);
});

test("play label names the file and the duration", () => {
  const t = (k, v) => v ? k.replace("{name}", v.name) : k;
  assert.equal(playLabel(t, "clip.mp4", "01:23"), "Play video: clip.mp4, 01:23");
  assert.equal(playLabel(t, "", ""), "Play video: Video");
});

// Minimal fake <video>: fires events like a WebView would.
function fakeDoc(behaviour) {
  const made = [];
  const doc = {
    made,
    createElement(tag) {
      if (tag === "canvas") return { width: 0, height: 0, getContext: () => ({ drawImage() {} }), setAttribute() {} };
      const v = {
        tag, duration: NaN, videoWidth: 0, videoHeight: 0, removed: false, loads: 0,
        removeAttribute() { this.removed = true; }, load() { this.loads++; },
        set src(u) { this._src = u; queueMicrotask(() => behaviour(this, u)); }, get src() { return this._src; },
        set currentTime(x) { this._t = x; queueMicrotask(() => this.onseeked?.()); },
      };
      made.push(v);
      return v;
    },
  };
  return doc;
}

test("probe paints the first frame, reports duration, releases the decoder", async () => {
  const doc = fakeDoc((v) => { v.duration = 42.5; v.videoWidth = 1280; v.videoHeight = 720; v.onloadedmetadata(); });
  const r = await probeVideo(["blobfile://a"], { doc, dpr: 1 }).promise;
  assert.equal(r.src, "blobfile://a");
  assert.equal(r.duration, 42.5);
  assert.ok(r.poster);
  assert.equal(r.poster.width, 320);
  assert.equal(doc.made[0]._t, 0.1);
  assert.ok(doc.made[0].removed && doc.made[0].loads === 1, "video element released");
});

test("probe falls back to the media-server URL when the first scheme fails", async () => {
  const doc = fakeDoc((v, u) => {
    if (u.startsWith("blobfile")) return v.onerror();
    v.duration = 3; v.videoWidth = 640; v.videoHeight = 360; v.onloadedmetadata();
  });
  const r = await probeVideo(["blobfile://a", "http://127.0.0.1:1/t/a"], { doc }).promise;
  assert.equal(r.src, "http://127.0.0.1:1/t/a");
  assert.equal(r.duration, 3);
  assert.ok(r.poster);
});

test("probe resolves without a poster on timeout or cancel, never rejects", async () => {
  const doc = fakeDoc(() => {});
  const r = await probeVideo(["x"], { doc, timeoutMs: 10 }).promise;
  assert.equal(r.poster, null);
  assert.ok(doc.made[0].removed);
  const p = probeVideo(["y"], { doc, timeoutMs: 60000 });
  p.cancel();
  assert.equal((await p.promise).poster, null);
});

test("strip wiring: lightbox player, streamed URL, replace, loader, paste and drop", () => {
  const cv = read("../app/js/chat-view.js");
  const html = read("../app/index.html");
  assert.match(html, /id="btn-media-replace" class="btn-text"[^>]*data-i18n="Replace"/);
  assert.match(cv, /_composerVideoCard\(pm\)/);
  assert.match(cv, /openVideoLightbox\(pm\.playUrl \|\| pm\.url/);
  assert.match(cv, /card\.setAttribute\("aria-busy", "true"\)/);
  assert.match(cv, /urls\.push\(mediaFallbackUrl\(pm\.corePath\)\)/);
  assert.match(cv, /this\.pendingMedia\?\.probe\?\.cancel\(\)/);
  assert.match(cv, /i\.type\.startsWith\("video\/"\)/);
  assert.match(cv, /listen\("tauri:\/\/drag-drop"/);
  // Staged videos are never read whole: the strip gets a URL, not bytes.
  assert.match(cv, /this\._setPendingMedia\("video", fileUrl\(resolved\), resolved, name\)/);
  // A video pick paints the strip before copy+seal. Dash route check is after.
  const queue = cv.slice(cv.indexOf("_queueStagedMedia(src"), cv.indexOf("_setPendingMedia(kind, src"));
  assert.match(queue, /resolveAttachmentPath/);
  assert.match(queue, /fileUrl\(dest\)/);
  const pick = cv.slice(cv.indexOf("async _sendAttachment(kind)"), cv.indexOf("listen(\"tauri://drag-drop\""));
  const paint = pick.indexOf("_queueStagedMedia(picked, pickedName, pickedView)");
  const copy = pick.indexOf("resolved = await resolveAttachmentPath");
  assert.ok(paint >= 0 && paint < copy, "picker strip before the copy");
  const drop = cv.slice(cv.indexOf("async _stageDroppedFiles"), cv.indexOf("async _heicToPhoto"));
  assert.ok(drop.indexOf('_queueStagedMedia(picked, name, "video")') < drop.indexOf("await resolveAttachmentPath"), "drop strip before the copy");
  assert.doesNotMatch(cv.slice(cv.indexOf("_composerVideoCard(pm) {"), cv.indexOf("// #470: which way the pending attachment")), /attachmentBytes|arrayBuffer|read_media_bytes/);
  // The Dash route line stays in the strip, next to the name.
  assert.match(html, /id="media-preview-name"[\s\S]*id="media-route" class="media-route" role="status"/);
  const ui = read("../app/js/ui.js");
  assert.match(ui, /lightboxReturn = document\.activeElement;/);
});

test("new strings exist in ru and fr", () => {
  for (const lang of ["ru", "fr"]) {
    const pack = JSON.parse(read(`../app/locales/${lang}.json`));
    for (const k of ["Play video: {name}", "Preview video", "Drop one file at a time", "Replace", "Crop", "Preparing file…"]) {
      assert.ok(pack[k], `${lang} ${k}`);
      if (k.includes("{name}")) assert.ok(pack[k].includes("{name}"));
    }
  }
});

// ---------- contrast ----------
const CSS = read("../app/css/main.css").replace(/\/\*[\s\S]*?\*\//g, "");
const ctx = { globalThis: {} }; ctx.globalThis = ctx; vm.runInNewContext(read("../app/js/chat-appearance.js"), ctx);
const A = ctx.VeltaChatAppearance;
const block = sel => { const i = CSS.indexOf(sel + " {"); assert.ok(i >= 0, sel); return CSS.slice(i, CSS.indexOf("\n}", i)); };
const parse = b => Object.fromEntries([...b.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)].map(m => [m[1], m[2].trim()]));
const ROOT = parse(block(":root"));
const THEMES = {
  dark: ROOT,
  light: { ...ROOT, ...parse(block('html[data-theme="light"]')) },
  brutal: { ...ROOT, ...parse(block('html[data-theme="brutal"]')) },
};
function resolve(t, v, d = 0) { assert.ok(d < 10, v); const m = /^var\((--[a-z0-9-]+)\)$/i.exec(v); return m ? resolve(t, t[m[1]], d + 1) : v; }
function rgba(v) {
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) { const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255, 1]; }
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) { const p = m[1].split(",").map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  throw new Error("color? " + v);
}
const over = (top, under) => { const a = top[3]; return [0, 1, 2].map(i => top[i] * a + under[i] * (1 - a)).concat(1); };
const lum = c => c.slice(0, 3).map(x => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }).reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const WHITE = [255, 255, 255, 1], BLACK = [0, 0, 0, 1];

function pairs(t) {
  const c = n => rgba(resolve(t, t[n]));
  const strip = c("--bg-sidebar");
  const tile = over(c("--bg-hover"), strip);
  const scrimW = over(c("--media-scrim"), WHITE), scrimB = over(c("--media-scrim"), BLACK);
  return [
    [".media-preview-name", c("--text"), strip, 4.5],
    [".media-route (size · route)", c("--text-dim"), strip, 4.5],
    ["Crop / Replace (.btn-text)", c("--accent-text"), strip, 4.5],
    [".mp-dur over a white frame", c("--media-on-scrim"), scrimW, 4.5],
    [".mp-dur over a black frame", c("--media-on-scrim"), scrimB, 4.5],
    [".mp-play icon over a white frame", c("--media-on-scrim"), scrimW, 3],
    [".mp-spinner / video glyph on the tile", c("--text-dim"), tile, 3],
    ["focus ring on the strip", c("--focus-ring"), strip, 3],
  ];
}
export function composerStripRatios(t) { return pairs(t).map(([w, fg, bg, min]) => [w, +ratio(fg, bg).toFixed(2), min]); }
const check = (label, th, t) => pairs(t).flatMap(([w, fg, bg, min]) => { const r = ratio(fg, bg); return r < min ? [`${label} ${th} ${w}: ${r.toFixed(2)} < ${min}`] : []; });

test("composer strip labels reach AA in every theme", () => {
  if (process.env.VELTA_PRINT_CONTRAST) for (const [th, t] of Object.entries(THEMES)) console.log(th, JSON.stringify(composerStripRatios(t)));
  assert.deepEqual(Object.entries(THEMES).flatMap(([th, t]) => check("default", th, t)), []);
});

test("composer strip labels reach AA with custom accents", () => {
  const bad = [];
  for (const acc of ["#1d3a8a", "#3fa34d", "#e0516e", "#f2e14c", "#a6e3ff", "#e8e8f0", "#10131a", "#f4f4f4"]) {
    for (const th of ["dark", "light", "brutal"]) {
      const d = A.deriveAccent(acc, th);
      const keys = th === "brutal" ? A.BRUTAL_KEYS : Object.keys(A.VAR_NAMES);
      const t = { ...THEMES[th] };
      for (const k of keys) t[A.VAR_NAMES[k]] = d[k];
      if (process.env.VELTA_PRINT_CONTRAST) console.log(acc, th, JSON.stringify(composerStripRatios(t).filter(([w]) => /Replace|focus/.test(w))));
      bad.push(...check(acc, th, t));
    }
  }
  assert.deepEqual(bad, []);
});
