#!/usr/bin/env node
// Phase 0 of docs/research/webxdc-group-calls.md — desktop/Android-shaped
// webxdc frame (cross-origin, sandbox WITHOUT allow-same-origin, the real
// WEBXDC_CSP + Permissions-Policy headers and iframe allow list, with and
// without the injected shim) in Chromium with fake devices and an
// auto-granting permission UI. The host page CAN capture (control); the app,
// a nested about:blank frame and a blob: frame inside it CANNOT.
// Usage: node scripts/e2e-webxdc-media-deny.mjs   (needs playwright chromium)
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const rs = readFileSync(root + 'velta-app/src-tauri/src/webxdc_serve.rs', 'utf8')
const unrs = (name) => rs.match(new RegExp(`${name}: &str = "(.*?)";`, 's'))[1].replace(/\\\n\s*/g, '')
const CSP = unrs('WEBXDC_CSP').replaceAll('http://webxdc.localhost', 'http://localhost:PORT')
const PP = unrs('WEBXDC_PERMISSIONS_POLICY')
const ALLOW = readFileSync(root + 'app/js/webxdc-manager.js', 'utf8').match(/WEBXDC_FRAME_ALLOW =\s*"([^"]+)"/)[1]
const SHIM = readFileSync(root + 'velta-app/src-tauri/src/webxdc-shim.js', 'utf8')

const probe = `<script>
async function t(w){try{const s=await w.navigator.mediaDevices.getUserMedia({audio:true,video:true});return 'GRANTED'}catch(e){return 'denied:'+e.name}}
(async()=>{const r={origin:self.origin,app:await t(window)};
 const f=document.createElement('iframe');document.body.appendChild(f);
 try{r.nested=await t(f.contentWindow)}catch(e){r.nested='denied:'+e.name}
 try{r.display=await navigator.mediaDevices.getDisplayMedia({video:true}).then(()=>'GRANTED',e=>'denied:'+e.name)}catch(e){r.display='denied:'+e.name}
 parent.postMessage({probe:r},'*')})()</script>`

const server = createServer((q, r) => {
  const port = server.address().port
  if (q.url.startsWith('/app')) {
    const shim = q.url.includes('shim') ? `<script>${SHIM}</script>` : ''
    r.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': CSP.replaceAll('PORT', port), 'permissions-policy': PP })
    return r.end(`<!doctype html><html><head>${shim}</head><body>${probe}</body></html>`)
  }
  r.writeHead(200, { 'content-type': 'text/html' })
  r.end(`<!doctype html><script>addEventListener('message',e=>{if(e.data&&e.data.probe)window.res=e.data.probe});
navigator.mediaDevices.getUserMedia({audio:true}).then(()=>window.host='GRANTED',e=>window.host='denied:'+e.name)</script>
<iframe sandbox="allow-scripts allow-downloads allow-forms allow-modals" allow="${ALLOW}" referrerpolicy="no-referrer" src="http://localhost:${port}/app${q.url.includes('shim') ? '?shim' : ''}"></iframe>`)
}).listen(0)
await new Promise((ok) => server.on('listening', ok))
const port = server.address().port

let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen'] })
try {
  for (const mode of ['shim', 'raw']) {
    const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${port}/host${mode === 'shim' ? '?shim' : ''}`)
    await page.waitForFunction(() => window.res && window.host, null, { timeout: 15000 })
    const host = await page.evaluate(() => window.host); const res = await page.evaluate(() => window.res)
    console.log(`  ${mode}:`, host, JSON.stringify(res))
    check(host === 'GRANTED', `${mode}: host page can capture (control)`)
    check(res.origin === 'null', `${mode}: app origin is opaque`)
    check(res.app.startsWith('denied'), `${mode}: app getUserMedia denied`)
    check(res.nested.startsWith('denied'), `${mode}: nested about:blank getUserMedia denied`)
    check(res.display.startsWith('denied'), `${mode}: app getDisplayMedia denied`)
    if (mode === 'shim') check(res.app === 'denied:NotAllowedError', 'shim: uniform NotAllowedError')
    await ctx.close()
  }
} finally { await browser.close(); server.close() }
if (failed) { console.log(`webxdc media-deny e2e: ${failed} FAILED`); process.exit(1) }
console.log('webxdc media-deny e2e: all checks passed')
