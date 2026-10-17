#!/usr/bin/env node
// C4: build the Velta PWA dist (Architecture C) — a static, deployable export
// of app/ plus the wasm core assets, a PWA config and a precache service
// worker. Output goes to build/dist-pwa and can be served by any static host.
//
// Usage:
//   node scripts/build-pwa.mjs [--app-root app] [--wasm-dist build/wasm-dist]
//        [--out build/dist-pwa] [--ws-proxy wss://host/path] [--wasm-opt [BIN]]
//
// --wasm-dist  wrapper build dir containing velta_wasm.js +
//              velta_wasm_bg.wasm (CI artifact layout or a local
//              wasm-pack build, see packages/velta-wasm/README.md)
// --ws-proxy   ws(s):// mail-proxy endpoint (relay websockify, C3); the dist
//              boots and persists accounts without one — it just can't
//              configure against a relay yet
// --wasm-opt   optimize the copied wasm in place with binaryen (pass a path,
//              or bare to use the $PATH one); deploy dists want this (~30 MB
//              no-opt → ~18.5 MB -Os)
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return null
  const next = args[i + 1]
  return next && !next.startsWith('--') ? next : true
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
// resolve (not join): absolute --out/--wasm-dist paths must win, relatives
// are repo-root based.
const appRoot = resolve(repoRoot, flag('app-root') || 'app')
const wasmDist = resolve(repoRoot, flag('wasm-dist') || 'build/wasm-dist')
const outDir = resolve(repoRoot, flag('out') || 'build/dist-pwa')
const wsProxy = flag('ws-proxy') || ''
const wasmOpt = flag('wasm-opt')

if (!existsSync(join(appRoot, 'index.html'))) {
  console.error(`FAIL: ${appRoot}/index.html missing`)
  process.exit(2)
}
if (!existsSync(join(wasmDist, 'velta_wasm.js')) || !existsSync(join(wasmDist, 'velta_wasm_bg.wasm'))) {
  // Wrapper builds from before the deltachat-wasm → velta-wasm rename: the
  // glue hard-codes its own deltachat_wasm_bg.wasm name, so renaming the
  // files is not enough — use a build of packages/velta-wasm instead.
  const legacy = existsSync(join(wasmDist, 'deltachat_wasm.js'))
    ? `\n(${wasmDist} holds deltachat_wasm.* from before the velta-wasm rename — rebuild; renaming the files breaks the glue)`
    : ''
  console.error(`FAIL: ${wasmDist} lacks velta_wasm.js / velta_wasm_bg.wasm${legacy} —
download the CI artifact: gh run download <run> -n wasm-dist-no-opt -D build/wasm-dist
or build locally:          packages/velta-wasm/README.md (wasm-pack)`)
  process.exit(2)
}

// 1. App tree as-is. The dist differs from app/ only by the added files and
//    the index.html patches below, so a plain copy is the whole transform.
cpSync(appRoot, outDir, { recursive: true })

// 2. Wasm core assets (glue + binary only; .d.ts/package.json are dev-only).
mkdirSync(join(outDir, 'wasm'), { recursive: true })
for (const f of ['velta_wasm.js', 'velta_wasm_bg.wasm']) {
  cpSync(join(wasmDist, f), join(outDir, 'wasm', f))
}
if (wasmOpt) {
  const bin = wasmOpt === true ? 'wasm-opt' : wasmOpt
  execFileSync(bin, ['-Os', join(outDir, 'wasm', 'velta_wasm_bg.wasm'), '-o', join(outDir, 'wasm', 'velta_wasm_bg.wasm')], { stdio: 'inherit' })
}
// #123: a wasm core without the sqlite_* bindings saves accounts.toml but
// never the databases, so every reload comes back unconfigured.
if (!readFileSync(join(outDir, 'wasm', 'velta_wasm.js'), 'utf8').includes('sqlite_export') && !args.includes('--allow-no-db-persist')) {
  console.error('FAIL: this wasm core cannot save its databases (no sqlite_export) — rebuild it from packages/velta-wasm, or pass --allow-no-db-persist for a throwaway dist')
  process.exit(2)
}
const wasmOut = join(outDir, 'wasm', 'velta_wasm_bg.wasm')
const wasmBytes = statSync(wasmOut).size
const wasmBuf = readFileSync(wasmOut)
writeFileSync(wasmOut + '.gz', gzipSync(wasmBuf, { level: 9 }))
writeFileSync(wasmOut + '.br', brotliCompressSync(wasmBuf, {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
}))
const wasmGz = statSync(wasmOut + '.gz').size
const wasmBr = statSync(wasmOut + '.br').size

// 3. index.html: relax the shell CSP for the PWA (wasm instantiation + worker
//    + the mail-proxy origin) and load pwa-config.js before the app module.
const indexPath = join(outDir, 'index.html')
let html = readFileSync(indexPath, 'utf8')
const cspMatch = html.match(/(Content-Security-Policy" content=")([^"]+)(")/)
if (!cspMatch) {
  console.error('FAIL: CSP meta not found in index.html')
  process.exit(2)
}
const directives = cspMatch[2].split(';').map((d) => d.trim()).filter(Boolean)
  .map((d) => [d.split(' ')[0], ...d.split(' ').slice(1)])
const get = (name) => directives.find(([k]) => k === name)
get('script-src').push("'wasm-unsafe-eval'")
// User-chosen relays (WebSocket relays setting) are not known at build time.
get('connect-src').push("https:", "wss:")
if (wsProxy) get('connect-src').push(wsProxy)
const csp = directives.map(([k, ...v]) => [k, ...v].join(' ')).join('; ')
html = html.replace(cspMatch[0], cspMatch[1] + csp + cspMatch[3])
const appTag = '<script type="module" src="js/app.js"></script>'
if (!html.includes(appTag)) {
  console.error('FAIL: app.js script tag not found in index.html')
  process.exit(2)
}
html = html.replace(appTag, `<script src="pwa-config.js"></script>\n${appTag}`)
writeFileSync(indexPath, html)

// 4. pwa-config.js — the single deployable-tunable file, plus SW registration.
writeFileSync(join(outDir, 'pwa-config.js'), `// Velta PWA dist configuration (C4) — generated by scripts/build-pwa.mjs.
// Served next to index.html; app/js/transport.js reads window.VELTA_PWA.
window.VELTA_PWA = {
  wasmCore: true, // no native shell here: the worker-wasm core IS the backend
  wsProxyUrl: ${JSON.stringify(wsProxy)}, // ws(s):// mail proxy (C3 websockify); "" until the relay ships it
};
if ('serviceWorker' in navigator) {
  // An installed PWA is resumed, not navigated, so the browser rarely checks
  // for a new sw.js on its own: ask again whenever the page comes back.
  // A new worker takes over at once (skipWaiting + claim); the page that was
  // already open still runs the old files, so tell the user to reload.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) dispatchEvent(new CustomEvent('velta-sw-updated'));
  });
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {}));
}
`)

// 4b. webxdc in the PWA (Step A, docs/research/beam-pwa-research.md): the
//     SW's webxdc route (app/webxdc-host/sw-route.js) inlines the loader
//     (app/webxdc-host/frame.js) and the SAME shim the native webxdc://
//     handler injects — copied from the Tauri tree, single source of truth.
const shimSrc = join(repoRoot, 'velta-app', 'src-tauri', 'src', 'webxdc-shim.js')
if (!existsSync(shimSrc) || !existsSync(join(outDir, 'webxdc-host', 'sw-route.js')) || !existsSync(join(outDir, 'webxdc-host', 'frame.js'))) {
  console.error('FAIL: webxdc host files missing (webxdc-shim.js / app/webxdc-host/)')
  process.exit(2)
}
cpSync(shimSrc, join(outDir, 'webxdc-shim.js'))

// 5. Service worker: precache the whole dist (app shell + wasm). Version is a
//    content hash of everything but the SW itself, so a redeploy invalidates
//    cleanly. sw.js is never precached (the browser manages SW updates).
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}
// .br/.gz sidecars are for nginx gzip_static/brotli_static. The SW fetches
// the raw file (the browser decodes Content-Encoding); precaching both
// would double the first-load transfer.
const files = [...walk(outDir)].map((p) => relative(outDir, p).replaceAll('\\', '/')).filter((f) => f !== 'sw.js' && !f.endsWith('.br') && !f.endsWith('.gz'))
const hash = createHash('sha256')
for (const f of files) hash.update(f).update(createHash('sha256').update(readFileSync(join(outDir, f))).digest())
writeFileSync(join(outDir, 'sw.js'), `// Velta PWA service worker — precache-the-dist (generated by scripts/build-pwa.mjs).
importScripts('webxdc-host/sw-route.js');
const VERSION = 'velta-pwa-${hash.digest('hex').slice(0, 12)}'
const PRECACHE = ${JSON.stringify(files, null, 2)};
self.addEventListener('install', (e) => {
  // cache: 'reload' skips the HTTP cache: a host that sends max-age on the
  // app files would otherwise fill the NEW cache with the OLD files, and the
  // deploy would never reach the page even though VERSION changed.
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// webxdc apps (sw-route.js): app frames get the sandboxed loader document;
// chat cards get icons. Runs first: it also refuses unsandboxed framing.
const WEBXDC_DEPS = {
  get scope() { return self.registration.scope; },
  readAsset: (path) => {
    const u = new URL(path, self.registration.scope).href;
    return caches.match(u, { ignoreSearch: true })
      .then((hit) => hit || fetch(u, { cache: 'no-cache' }))
      .then((r) => { if (!r.ok) throw new Error('missing ' + path); return r.text(); });
  },
  iconBytes: (account, msg, path, clientId) => askClient(clientId, { type: 'velta-webxdc-icon', account, msg, path }),
};
async function askClient(clientId, msg) {
  const client = (clientId && await self.clients.get(clientId)) || (await self.clients.matchAll({ type: 'window' }))[0];
  if (!client) return null;
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('timeout')), 20000);
    ch.port1.onmessage = (ev) => {
      clearTimeout(timer);
      if (ev.data && ev.data.error) reject(new Error(ev.data.error));
      else resolve(ev.data && ev.data.bytes);
    };
    client.postMessage(msg, [ch.port2]);
  });
}
self.addEventListener('fetch', (e) => {
  const wx = self.veltaWebxdcSw && self.veltaWebxdcSw.route(e.request, e.clientId, WEBXDC_DEPS);
  if (wx) { e.respondWith(wx); return; }
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/blob') && url.searchParams.has('p')) {
    e.respondWith(serveAccountBlob(e, url.searchParams.get('p')));
    return;
  }
  // The page itself goes to the network first, so a redeploy shows up on
  // the next load; offline it falls back to the precached shell.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request, { cache: 'no-cache' })
      .then((r) => (r.ok ? r : caches.match('index.html', { ignoreSearch: true }).then((hit) => hit || r)))
      .catch(() => caches.match('index.html', { ignoreSearch: true }).then((hit) => hit || Response.error())));
    return;
  }
  e.respondWith(caches.open(VERSION).then((c) => c.match(e.request)).then((hit) => hit || fetch(e.request)));
});
// Notification tap (PWA): focus an in-scope client and hand it the chat
// target; if none exists, open one and stash the click until that page
// (now controlled) asks for it.
let pendingClick = null;
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil((async () => {
    const scope = new URL(self.registration.scope);
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const inScope = clients.filter((c) => {
      try { const u = new URL(c.url); return u.origin === scope.origin && u.pathname.startsWith(scope.pathname); } catch { return false; }
    });
    const hit = inScope.find((c) => c.visibilityState === 'visible') || inScope[0];
    const msg = { type: 'velta-notification-click', accountId: data.accountId ?? null, chatId: data.chatId ?? null };
    if (hit) {
      await hit.focus();
      hit.postMessage(msg);
      return;
    }
    pendingClick = msg;
    await self.clients.openWindow(scope.href);
  })());
});
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'velta-sw-version') {
    e.source.postMessage({ type: 'velta-sw-version', version: VERSION });
    return;
  }
  if (e.data && e.data.type === 'velta-pending-notification' && pendingClick) {
    e.source.postMessage(pendingClick);
    pendingClick = null;
  }
});
function serveAccountBlob(event, path) {
  if (!path || !path.startsWith('/accounts/') || path.includes('..')) {
    return Promise.resolve(new Response('bad path', { status: 400 }));
  }
  const ext = (path.split('.').pop() || '').toLowerCase();
  const type = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', pdf: 'application/pdf' })[ext] || 'application/octet-stream';
  return (async () => {
    const client = await self.clients.get(event.clientId) || (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))[0];
    if (!client) return new Response('no client', { status: 404 });
    const bytes = await new Promise((resolve, reject) => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => reject(new Error('timeout')), 20000);
      ch.port1.onmessage = (ev) => {
        clearTimeout(timer);
        if (ev.data && ev.data.error) reject(new Error(ev.data.error));
        else resolve(ev.data && ev.data.bytes);
      };
      client.postMessage({ type: 'velta-blob', path }, [ch.port2]);
    });
    if (!bytes) return new Response('missing', { status: 404 });
    return new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' } });
  })().catch(() => new Response('blob failed', { status: 404 }));
}
`)

console.log(`PWA dist: ${outDir} (${files.length} files, wasm ${(wasmBytes / 1048576).toFixed(1)} MB raw / ${(wasmBr / 1048576).toFixed(1)} MB br / ${(wasmGz / 1048576).toFixed(1)} MB gz${wasmOpt ? ', optimized' : ', NO-OPT — pass --wasm-opt for deploys'})`)
