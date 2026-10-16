// Webxdc in the wasm PWA (Step A, docs/research/beam-pwa-research.md):
// service-worker route (app/webxdc-host/sw-route.js), in-frame loader
// (app/webxdc-host/frame.js), host bridge (webxdc-manager.js) and the Beam
// "no realtime in the web app" state. Browser-level coverage (real SW,
// opaque frame, CSP) lives in scripts/e2e-webxdc-pwa.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { deflateRawSync } from "node:zlib";
import { installChatViewGlobals, installFakeDocument } from "./helpers/fake-dom.mjs";
import { zipStore, crc32 } from "../tools/build-builtin-xdc.mjs";

installChatViewGlobals();
installFakeDocument();
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// --- sw-route.js -----------------------------------------------------------
const swCtx = { URL, Response, Promise, JSON };
swCtx.globalThis = swCtx;
vm.createContext(swCtx);
vm.runInContext(src("app/webxdc-host/sw-route.js"), swCtx);
const SW = swCtx.veltaWebxdcSw;
const SCOPE = "https://pwa.example/app/";
const deps = (over = {}) => ({
  scope: SCOPE,
  readAsset: async (p) => (p === "webxdc-host/frame.js" ? "/*loader*/" : "/*shim </script> */"),
  iconBytes: async () => new Uint8Array([1, 2, 3]),
  ...over,
});
const req = (url, mode = "no-cors", destination = "image", method = "GET") => ({ url, mode, destination, method });

test("sw-route: parses <scope>webxdc-run/<account>/<msg>/<path>", () => {
  assert.deepEqual({ ...SW.parseRunUrl(SCOPE + "webxdc-run/1/42/index.html?velta-theme=dark", SCOPE) }, { account: 1, msg: 42, path: "index.html" });
  assert.deepEqual({ ...SW.parseRunUrl(SCOPE + "webxdc-run/3/7/", SCOPE) }, { account: 3, msg: 7, path: "index.html" });
  assert.equal(SW.parseRunUrl(SCOPE + "webxdc-run/3/7/a%2F..%2Fb", SCOPE).bad, true);
  assert.equal(SW.parseRunUrl(SCOPE + "webxdc-run/x/7/", SCOPE).bad, true);
  assert.equal(SW.parseRunUrl(SCOPE + "index.html", SCOPE), null);
  assert.equal(SW.parseRunUrl("https://evil.example/app/webxdc-run/1/2/", SCOPE), null);
});

test("sw-route: app frame navigation gets the loader with an opaque, network-less CSP", async () => {
  const r = await SW.route(req(SCOPE + "webxdc-run/1/42/index.html", "navigate", "iframe"), "c", deps());
  assert.equal(r.status, 200);
  const csp = r.headers.get("Content-Security-Policy");
  assert.match(csp, /^sandbox allow-scripts /);
  assert.doesNotMatch(csp, /allow-same-origin|allow-popups|allow-top-navigation/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src blob: data:;/);
  assert.doesNotMatch(csp, /'self'|https?:|wss?:/, "no network source anywhere");
  assert.match(csp, /form-action 'none'/);
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  const html = await r.text();
  assert.match(html, /<script>\/\*loader\*\/<\/script>/);
  assert.ok(html.includes('window.__VELTA_SHIM_SRC="/*shim \\u003c/script> */"'), "shim JSON cannot close the script element");
});

test("sw-route: refuses top-level app loads, unsandboxed framing and non-icon reads", async () => {
  assert.equal((await SW.route(req(SCOPE + "webxdc-run/1/42/index.html", "navigate", "document"), "c", deps())).status, 403);
  const framed = await SW.route(req(SCOPE + "index.html", "navigate", "iframe"), "c", deps());
  assert.equal(framed.status, 403);
  assert.equal(framed.headers.get("Content-Security-Policy"), "sandbox");
  assert.equal((await SW.route(req(SCOPE + "webxdc-run/1/42/main.js", "no-cors", "script"), "c", deps())).status, 404);
  assert.equal((await SW.route(req(SCOPE + "webxdc-run/1/42/icon.png", "no-cors", "image", "POST"), "c", deps())).status, 404);
  assert.equal(SW.route(req(SCOPE + "js/app.js", "no-cors", "script"), "c", deps()), null, "ordinary files fall through");
  assert.equal(SW.route(req("https://cdn.example/x.js", "no-cors", "script"), "c", deps()), null);
  assert.equal(SW.route(req("https://pwa.example/other/x", "navigate", "iframe"), "c", deps()), null, "out of scope");
});

test("sw-route: icons come from the page (any instance), loader failure is a 503", async () => {
  let asked = null;
  const r = await SW.route(req(SCOPE + "webxdc-run/2/9/icon.png"), "client-1",
    deps({ iconBytes: async (...a) => { asked = a; return new Uint8Array([7]); } }));
  assert.deepEqual(asked, [2, 9, "icon.png", "client-1"]);
  assert.equal(r.headers.get("Content-Type"), "image/png");
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [7]);
  const missing = await SW.route(req(SCOPE + "webxdc-run/2/9/icon.jpg"), "c", deps({ iconBytes: async () => null }));
  assert.equal(missing.status, 404);
  const down = await SW.route(req(SCOPE + "webxdc-run/1/1/", "navigate", "iframe"), "c", deps({ readAsset: async () => { throw new Error("x"); } }));
  assert.equal(down.status, 503);
  assert.throws(() => SW.frameHtml("a</script>b", ""), /not inlinable/);
  assert.equal(SW.inlineJson("<\u2028"), '"\\u003c\\u2028"');
});

// --- frame.js --------------------------------------------------------------
const frameSrc = src("app/webxdc-host/frame.js");
const F = (() => {
  const ctx = { __VELTA_FRAME_NO_BOOT: true, URL, Blob, TextDecoder, Response, DecompressionStream, Promise, Map, Set, JSON, Math };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(frameSrc, ctx);
  return ctx.VeltaWebxdcFrame;
})();

test("frame.js stays inlinable into the SW's script element", () => {
  assert.doesNotMatch(frameSrc, /<\/script|<!--/i);
  assert.doesNotThrow(() => SW.frameHtml(frameSrc, src("velta-app/src-tauri/src/webxdc-shim.js")));
});

function zipDeflate(entries) {
  const locals = []; const central = []; let off = 0;
  for (const [name, data] of entries) {
    const raw = Buffer.from(data); const comp = deflateRawSync(raw); const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp); central.push(ch, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}
const inflate = async (raw) => new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());

test("frame.js: unzips stored (built-in Beam) and deflated archives, drops escaping paths", async () => {
  const beam = await F.unzip(new Uint8Array(readFileSync(new URL("../app/builtin/send-direct.xdc", import.meta.url))), inflate);
  assert.ok(beam.has("index.html") && beam.has("main.js") && beam.has("manifest.toml"));
  const z = await F.unzip(zipDeflate([["a/b.txt", "hello"], ["../evil.txt", "x"], ["./c//d.js", "1"], ["dir/", ""]]), inflate);
  assert.deepEqual([...z.keys()].sort(), ["a/b.txt", "c/d.js"]);
  assert.equal(new TextDecoder().decode(z.get("a/b.txt")), "hello");
  await assert.rejects(F.unzip(new Uint8Array([1, 2, 3]), inflate), /not a zip/);
  assert.equal(F.normPath("a/../../b"), null);
  assert.equal(F.normPath("/x/./y"), "x/y");
});

function makeVfs(entries) {
  const files = new Map(entries.map(([k, v]) => [k, new TextEncoder().encode(v)]));
  const made = [];
  const vfs = F.createVfs(files, {
    origin: "https://pwa.example", appBasePath: "/app/webxdc-run/1/42/", scopePath: "/app/",
    createObjectURL: (b) => { made.push(b); return `blob:null/${made.length}`; },
  });
  return { vfs, made };
}
const PAGE = "https://pwa.example/app/webxdc-run/1/42/index.html";

test("frame.js vfs: maps app-relative, vite-absolute and webxdc.js references; leaves others", async () => {
  const { vfs, made } = makeVfs([["img/a.png", "P"], ["assets/x.js", "1"], ["index.html", "<p>"]]);
  assert.equal(vfs.toPath("img/a.png", PAGE), "img/a.png");
  assert.equal(vfs.toPath("/app/assets/x.js", PAGE), "assets/x.js", "vite base '/' under a sub-path scope");
  assert.equal(vfs.toPath("https://evil.example/a.png", PAGE), null);
  assert.equal(vfs.toPath("data:,x", PAGE), null);
  assert.equal(vfs.mapUrl("img/a.png#frag", PAGE), "blob:null/1#frag");
  assert.equal(vfs.mapUrl("img/a.png", PAGE), "blob:null/1", "one blob per file");
  assert.equal(made[0].type, "image/png");
  assert.equal(vfs.mapUrl("missing.png", PAGE), null);
  assert.ok(vfs.mapUrl("webxdc.js", PAGE), "webxdc.js aliased (shim already inlined)");
  assert.match(await made[made.length - 1].text(), /provided by the Velta host/);
});

test("frame.js vfs: CSS url()/@import and ES-module specifiers are rewritten", async () => {
  const { vfs, made } = makeVfs([
    ["s.css", '@import "t.css"; a{background:url( "img/a.png" )} b{background:url(data:x)}'],
    ["t.css", "i{}"], ["img/a.png", "P"],
    ["m/main.js", 'import {d} from "./dep.js";\nimport "../side.js";\nexport * from "./dep.js";\nconst u = new URL("x.png", import.meta.url);\nconst l = await import("./lazy.js");\nobj.import("y"); import("react");'],
    ["m/dep.js", "export const d = 1;"], ["side.js", ""], ["m/lazy.js", ""],
  ]);
  const css = vfs.rewriteCss(new TextDecoder().decode(vfs.files.get("s.css")), "https://pwa.example/app/webxdc-run/1/42/s.css");
  assert.match(css, /@import "blob:null\/\d+"/);
  assert.match(css, /url\( ?"blob:null\/\d+" ?\)/);
  assert.match(css, /url\(data:x\)/);
  const url = vfs.mapModule("m/main.js", PAGE);
  const out = await made.find((b, i) => `blob:null/${i + 1}` === url).text();
  assert.match(out, /from "blob:null\/\d+"/);
  assert.match(out, /import "blob:null\/\d+"/);
  assert.ok(out.includes('new URL("x.png", "https://pwa.example/app/webxdc-run/1/42/m/main.js")'));
  assert.match(out, /^const __veltaImport = \(s\) => globalThis\.__veltaDynImport\(s, "https:\/\/pwa\.example\/app\/webxdc-run\/1\/42\/m\/main\.js"\);/);
  assert.match(out, /await __veltaImport\("\.\/lazy\.js"\)/);
  assert.match(out, /obj\.import\("y"\)/, "method calls named import untouched");
  assert.match(out, /__veltaImport\("react"\)/);
});

test("frame.js vfs: static import cycles fail with a clear error", () => {
  const { vfs } = makeVfs([["a.js", 'import "./b.js";'], ["b.js", 'import "./a.js";']]);
  assert.throws(() => vfs.mapModule("a.js", PAGE), /import cycle/);
});

test("frame.js boot refuses a non-opaque or top-level document", () => {
  for (const win of [
    { origin: "https://pwa.example", parent: {}, document: { body: {} } },
    (() => { const w = { origin: "null", document: { body: {} } }; w.parent = w; return w; })(),
  ]) {
    let asked = false;
    win.parent.postMessage = () => { asked = true; };
    win.addEventListener = () => { asked = true; };
    F.boot(win);
    assert.match(win.document.body.textContent, /Refusing to start/);
    assert.equal(asked, false, "never asks the host for the archive");
  }
});

// --- host bridge ------------------------------------------------------------
const wx = await import("../app/js/webxdc-manager.js");

test("host: realtime is reported unavailable only in the PWA", () => {
  const prev = { tauri: window.__TAURI__, pwa: window.VELTA_PWA };
  try {
    window.__TAURI__ = undefined; window.VELTA_PWA = { wasmCore: true };
    assert.equal(wx.isPwaHost(), true);
    assert.equal(wx.realtimeAvailable(), false);
    window.__TAURI__ = { core: {} };
    assert.equal(wx.isPwaHost(), false);
    assert.equal(wx.realtimeAvailable(), true);
  } finally { window.__TAURI__ = prev.tauri; window.VELTA_PWA = prev.pwa; }
  const mgr = src("app/js/webxdc-manager.js");
  assert.match(mgr, /if \(!realtimeAvailable\(\)\) throw new Error\(REALTIME_UNAVAILABLE\)/);
  assert.match(mgr, /veltaRealtime: realtimeAvailable\(\)/);
  assert.match(mgr, /case "veltaBundle":/);
  // KEEP: PWA attribute keeps allow-same-origin only because the SW's CSP
  // header makes the document opaque; native stays without it.
  assert.match(mgr, /"allow-scripts allow-same-origin allow-downloads allow-forms allow-modals"\s*:\s*"allow-scripts allow-downloads allow-forms allow-modals"/);
});

test("host: icon requests are account- and path-gated", async () => {
  const core = new EventTarget();
  core.accountId = 5;
  let asked = null;
  core.getWebxdcBlob = async (m, p) => { asked = [m, p]; return Buffer.from("PNG").toString("base64"); };
  wx.initWebxdc(core);
  assert.equal(new TextDecoder().decode(await wx.serveIconRequest({ account: 5, msg: 9, path: "icon.png" })), "PNG");
  assert.deepEqual(asked, [9, "icon.png"]);
  await assert.rejects(wx.serveIconRequest({ account: 6, msg: 9, path: "icon.png" }), /wrong account/);
  await assert.rejects(wx.serveIconRequest({ account: 5, msg: 9, path: "main.js" }), /not an icon/);
  await assert.rejects(wx.serveIconRequest({ account: 5, msg: 9, path: "../icon.png" }), /not an icon/);
  assert.equal(wx.acceptFor({ extensions: ["png", ".jpg"], mimeTypes: ["image/*"] }), ".png,.jpg,image/*");
  assert.equal(wx.acceptFor({}), "");
});

test("shim + Beam: realtime-unavailable state", () => {
  const shim = src("velta-app/src-tauri/src/webxdc-shim.js");
  assert.match(shim, /if \(info\.veltaRealtime === false\) throw new Error/);
  assert.match(shim, /"veltaRealtimeAvailable"/);
  assert.match(shim, /d\.id === "info"/, "the eager getInfo answer is applied");
  const ui = src("app/webxdc/send-direct/ui.js");
  assert.match(ui, /wx\.veltaRealtimeAvailable === false\) \{ markNoRealtime\(\)/);
  assert.match(ui, /not available in the Velta web app yet/);
  assert.match(ui, /b\.disabled = !online \|\| noRealtime/);
});

test("build-pwa wires the SW route, loader and the shared shim", () => {
  const b = src("scripts/build-pwa.mjs");
  assert.match(b, /importScripts\('webxdc-host\/sw-route\.js'\)/);
  assert.match(b, /self\.veltaWebxdcSw\.route\(e\.request, e\.clientId, WEBXDC_DEPS\)/);
  assert.match(b, /cpSync\(shimSrc, join\(outDir, 'webxdc-shim\.js'\)\)/);
  // the webxdc route runs before the GET-only early return (it must also
  // answer non-GET app requests with 404 rather than the network)
  assert.ok(b.indexOf("veltaWebxdcSw.route") < b.indexOf("if (e.request.method !== 'GET') return;"));
  assert.ok(zipStore, "zip helper available");
});
