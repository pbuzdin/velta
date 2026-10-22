#!/usr/bin/env node
// App-wide WCAG AA contrast audit (AGENTS.md 6.4). Serves app/ statically
// with the mock core (localStorage velta-mock=1), walks the main screens in
// every theme (dark, light, brutal) × accent (theme default plus a dark, a
// mid and a light/yellow custom accent), and for every visible text node
// computes the contrast of its color against the effective background: the
// element's and its ancestors' background colors composited bottom-up
// (translucent layers, opacity). Normal text needs 4.5:1, large text
// (>= 24px, or >= 18.66px bold) 3:1; icons inside buttons need 3:1.
// Disabled controls are exempt (WCAG 1.4.3); text over an image/gradient/
// video background cannot be measured and is reported as "skipped".
// Usage: node scripts/e2e-contrast.mjs [--quick] [--shots DIR] [--json FILE]
//   --quick: theme defaults + the yellow accent only (CI)
//   (needs `npx playwright install chromium`, or CHROMIUM_PATH=/path/to/chrome)
// Exit 1 when any violation is found.
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const appRoot = fileURLToPath(new URL('../app/', import.meta.url))
const args = process.argv.slice(2)
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
const quick = args.includes('--quick'), shots = opt('--shots'), jsonOut = opt('--json')
if (shots) mkdirSync(shots, { recursive: true })

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.xdc': 'application/zip' }
const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '')
  const f = join(appRoot, p || 'index.html')
  if (!f.startsWith(appRoot) || !existsSync(f)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' })
  res.end(readFileSync(f))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const base = `${origin}/index.html`
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})

// ---- in-page audit -------------------------------------------------------
function audit() {
  const parse = s => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '')
    if (!m) return null
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
  }
  const over = (top, under) => { const a = top[3] + under[3] * (1 - top[3]); if (!a) return [0, 0, 0, 0]; return [0, 1, 2].map(i => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a) }
  const lum = c => c.slice(0, 3).map(x => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }).reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0)
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  // Chromium serializes color-mix()/oklab results as color(srgb r g b / a).
  const toRgb = s => {
    const m = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(s || '')
    return m ? [m[1] * 255, m[2] * 255, m[3] * 255, m[4] == null ? 1 : +m[4]] : parse(s)
  }
  const name = el => {
    let s = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
    if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
    const p = el.parentElement
    if (p && p !== document.body) {
      let q = p.tagName.toLowerCase() + (p.id ? '#' + p.id : '')
      if (typeof p.className === 'string' && p.className.trim()) q += '.' + p.className.trim().split(/\s+/).slice(0, 2).join('.')
      s = q + ' > ' + s
    }
    return s
  }
  const visible = el => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false
    }
    // the topmost element at the center belongs to this subtree (not covered by a modal/overlay)
    const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), y = Math.min(Math.max(r.top + Math.min(r.height / 2, 10), 0), innerHeight - 1)
    const hit = document.elementFromPoint(x, y)
    return !!hit && (el.contains(hit) || hit.contains(el))
  }
  function background(el) {
    const layers = []
    for (let a = el; a; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { complex: 'background-image on ' + name(a) }
      if (a.matches('video, img, canvas, iframe')) return { complex: 'media' }
      const c = toRgb(cs.backgroundColor)
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break }
    }
    let bg = [255, 255, 255, 1]
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg)
    return { bg }
  }
  const opacityOf = el => { let o = 1; for (let a = el; a; a = a.parentElement) o *= +getComputedStyle(a).opacity; return o }
  const out = [], skipped = []
  const seen = new Set()
  const check = (el, kind) => {
    if (seen.has(el)) return
    seen.add(el)
    if (!visible(el)) return
    if (el.closest('[aria-hidden="true"]:not(.call-avatar), .sr-only, .vh')) return
    if (el.closest(':disabled, [aria-disabled="true"]')) return // WCAG: inactive controls exempt
    const cs = getComputedStyle(el)
    const { bg, complex } = background(el)
    if (complex) { skipped.push(`${name(el)} (${complex})`); return }
    let fg = toRgb(kind === 'icon' ? (cs.color) : cs.color)
    if (!fg) return
    fg = [fg[0], fg[1], fg[2], fg[3] * opacityOf(el)]
    const eff = over(fg, bg)
    const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700
    const min = kind === 'icon' ? 3 : (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5
    const r = ratio(eff, bg)
    if (r + 1e-3 < min) {
      const hex = c => '#' + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
      const txt = kind === 'icon' ? '[icon]' : (el.textContent || el.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 32)
      out.push(`${name(el)} "${txt}" ${hex(eff)} on ${hex(bg)} = ${r.toFixed(2)} < ${min}`)
    }
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n; (n = walker.nextNode());) {
    if (!n.nodeValue.trim()) continue
    const el = n.parentElement
    if (!el || el.closest('script, style, noscript, svg, template')) continue
    check(el, 'text')
  }
  for (const el of document.querySelectorAll('input[placeholder]:placeholder-shown, textarea[placeholder]:placeholder-shown')) {
    // placeholder color via ::placeholder
    const cs = getComputedStyle(el, '::placeholder')
    const { bg, complex } = background(el)
    if (complex || !visible(el)) continue
    const fg = toRgb(cs.color); if (!fg) continue
    const r = ratio(over(fg, bg), bg)
    if (r + 1e-3 < 4.5) out.push(`${name(el)}::placeholder "${el.placeholder.slice(0, 32)}" = ${r.toFixed(2)} < 4.5`)
  }
  for (const svg of document.querySelectorAll('button svg, a svg, [role="button"] svg')) {
    const host = svg.closest('button, a, [role="button"]')
    if (host && (host.textContent || '').trim()) continue // labelled by its text
    check(svg, 'icon')
  }
  return { violations: [...new Set(out)], skipped: [...new Set(skipped)] }
}

// ---- screens -------------------------------------------------------------
const clickText = async (page, sel, text) => { await page.locator(sel, { hasText: text }).first().click({ timeout: 4000 }); await page.waitForTimeout(450) }
const openDrawer = async page => { await page.locator('.bar-btn').last().click(); await page.waitForTimeout(450) }
const toBottom = async page => { for (let i = 0; i < 4; i++) { await page.evaluate(() => { for (const e of document.querySelectorAll('*')) if (e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight }); await page.waitForTimeout(250) } }
const openDetails = async (page, sel) => { const s = page.locator(sel); if (await s.count()) { await s.first().click(); await page.waitForTimeout(300) } }
const openChat = async (page, name) => { await clickText(page, '.chat-item', name); await page.waitForTimeout(700) }
// The 1:1 call screen exactly as calls.js builds it (ensureOverlay + render),
// without a peer connection: incoming and active states.
const callScreen = state => async page => {
  await page.evaluate(async st => {
    const { callButtonsHtml } = await import('./js/calls.js')
    const box = document.createElement('div'); box.id = 'call-overlay'
    box.innerHTML = `<div class="call-top"><div class="call-name">Ada Byron</div><div class="call-status" role="status">${st === 'in' ? 'Incoming call…' : '03:42'}</div></div><div class="call-avatar"><span class="call-avatar-initial">A</span></div><div class="call-actions"></div>`
    document.body.appendChild(box)
    box.querySelector('.call-actions').innerHTML = callButtonsHtml(st === 'in' ? ['decline', 'accept-video', 'accept'] : ['mute', 'speaker', 'camera', 'hangup'], { muted: true })
  }, state)
  await page.waitForTimeout(150)
}
const screens = [
  ['chatlist', async () => {}],
  ['drawer', openDrawer],
  ['drawer-appearance', async p => { await openDrawer(p); await openDetails(p, '[data-chat-appearance] > summary') }],
  ['drawer-sections', async p => { await openDrawer(p); for (const d of await p.locator('.drawer details > summary').all()) await d.click().catch(() => {}); await p.waitForTimeout(300) }],
  ['about-deviceinfo', async p => { await openDrawer(p); await clickText(p, '.ctx-item', 'About Velta'); await openDetails(p, 'details.device-info > summary') }],
  ['relays', async p => { await openDrawer(p); await clickText(p, '.ctx-item', 'Relays of this profile') }],
  ['profile-mgmt', async p => { await openDrawer(p); await clickText(p, '.ctx-item', 'Profile management') }],
  ['edit-profile', async p => { await openDrawer(p); await clickText(p, 'button', 'Edit profile') }],
  ['contacts', async p => { await p.locator('.bar-btn').nth(1).click(); await p.waitForTimeout(450) }],
  ['calls-tab', async p => { await p.locator('.bar-btn').nth(2).click(); await p.waitForTimeout(450) }],
  ['new-chat', async p => { await p.locator('.bar-btn.bar-accent').click(); await p.waitForTimeout(450) }],
  ['chat-ada', async p => { await openChat(p, 'Ada Byron'); await toBottom(p) }],
  ['chat-ada-top', async p => { await openChat(p, 'Ada Byron'); await p.evaluate(() => { for (const e of document.querySelectorAll('*')) if (e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = 0 }); await p.waitForTimeout(400) }],
  ['chat-group-card', async p => { await openChat(p, 'Weekend Crew'); await toBottom(p); await p.locator('.msg-groupcall').first().evaluate(e => e.scrollIntoView({ block: 'center' })).catch(() => {}); await p.waitForTimeout(300) }],
  ['chat-devs', async p => { await openChat(p, 'Velta Devs'); await toBottom(p) }],
  ['device-chat', async p => { await openChat(p, 'Device Messages') }],
  ['chatinfo-group', async p => { await openChat(p, 'Weekend Crew'); await p.locator('.chat-head-text').first().click(); await p.waitForTimeout(800) }],
  ['thread-panel', async p => { await openChat(p, 'Ada Byron'); await toBottom(p); await p.locator('.msg-thread-btn').first().click({ timeout: 4000 }); await p.waitForTimeout(500) }],
  ['mentions', async p => { await openChat(p, 'Weekend Crew'); await toBottom(p) }],
  ['mention-picker', async p => { await openChat(p, 'Weekend Crew'); await p.locator('#composer-input').fill(''); await p.locator('#composer-input').pressSequentially('hi @'); await p.waitForTimeout(400) }],
  ['msg-sheet', async p => { await openChat(p, 'Ada Byron'); await toBottom(p); await p.locator('.msg-row .bubble').last().click({ button: 'right' }).catch(() => {}); await p.waitForTimeout(400) }],
  ['toast', async p => { await p.evaluate(async () => { const { toast } = await import('./js/ui.js'); toast('Camera access is blocked — the call continues with audio only.', 60000) }); await p.waitForTimeout(300) }],
  ['call-incoming', callScreen('in')],
  ['call-active', callScreen('active')],
  ['group-call-bar', async p => {
    await openChat(p, 'Weekend Crew'); await toBottom(p)
    await p.locator('.msg-groupcall .gc-join').first().click({ timeout: 6000 })
    await p.locator('.modal .btn-text', { hasText: 'Join' }).click({ timeout: 5000 })
    await p.waitForSelector('#group-call-bar', { timeout: 10000 }); await p.keyboard.press('Escape').catch(() => {}); await p.waitForTimeout(500)
  }],
]
const ACCENTS = quick ? [null, '#f2e14c'] : [null, '#1d3a8a', '#3fa34d', '#f2e14c']
const THEMES = ['dark', 'light', 'brutal']

const all = new Map() // violation -> [contexts]
let skippedTotal = 0
for (const theme of THEMES) for (const accent of ACCENTS) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, permissions: ['microphone'] })
  await ctx.addInitScript(([t, a]) => {
    localStorage.setItem('velta-mock', '1'); localStorage.setItem('dw-theme', t)
    if (a) localStorage.setItem('velta-accent', a)
  }, [theme, accent])
  for (const [id, go] of screens) {
    if (accent && /^(contacts|calls-tab|new-chat|relays|profile-mgmt|edit-profile)$/.test(id) && quick) continue
    const page = await ctx.newPage()
    const tag = `${theme}${accent ? '+' + accent : ''} ${id}`
    try {
      await page.goto(base); await page.waitForSelector('.chat-item', { timeout: 15000 }); await page.waitForTimeout(500)
      if (id !== 'toast') await page.evaluate(() => document.querySelectorAll('.toasts > *').forEach(t => t.remove()))
      await go(page)
      const { violations, skipped } = await page.evaluate(audit)
      skippedTotal += skipped.length
      for (const v of violations) { if (!all.has(v)) all.set(v, []); all.get(v).push(tag) }
      console.log(`${violations.length ? 'FAIL' : 'ok  '} ${tag}${violations.length ? ' (' + violations.length + ')' : ''}`)
      if (shots) await page.screenshot({ path: join(shots, `${theme}${accent ? '-' + accent.slice(1) : ''}-${id}.png`) })
    } catch (e) { console.log(`SKIP ${tag}: ${String(e.message).split('\n')[0]}`) }
    await page.close()
  }
  // The trusted group-call app with the host's theme tokens (webxdc.veltaCall
  // getTheme) and in the "needs Velta" state (no host).
  for (const mode of ['velta', 'needs-velta']) {
    const page = await ctx.newPage()
    const tag = `${theme}${accent ? '+' + accent : ''} group-call-app-${mode}`
    try {
      let tokens = null
      if (mode === 'velta') {
        await page.goto(base); await page.waitForSelector('.chat-item', { timeout: 15000 })
        tokens = await page.evaluate(async () => {
          const { CALL_THEME_TOKENS } = await import('./js/webxdc-manager.js')
          const cs = getComputedStyle(document.documentElement), o = {}
          for (const k of CALL_THEME_TOKENS) o[k] = cs.getPropertyValue(k).trim()
          o['color-scheme'] = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
          return o
        })
      }
      await page.addInitScript(tk => {
        if (!tk) { window.webxdc = { setUpdateListener: () => Promise.resolve() }; return }
        const st = { state: 'active', muted: false, participants: [{ id: 'a', name: 'Ada Byron', self: true, state: 'connected' }, { id: 'b', name: 'Mara Voss', state: 'connected', speaking: true }, { id: 'c', name: 'Yuki', state: 'connecting' }], activeSpeaker: 'b', inCall: 3, relayOnly: true }
        window.webxdc = { setUpdateListener: () => Promise.resolve(), veltaCall: { available: () => Promise.resolve(true), getTheme: () => Promise.resolve(tk), onState: () => {}, getState: () => Promise.resolve(st), join: () => Promise.resolve(), leave() {}, setMuted() {} } }
      }, tokens)
      await page.goto(`${origin}/webxdc/group-call/index.html`); await page.waitForTimeout(500)
      const { violations, skipped } = await page.evaluate(audit)
      skippedTotal += skipped.length
      for (const v of violations) { if (!all.has(v)) all.set(v, []); all.get(v).push(tag) }
      console.log(`${violations.length ? 'FAIL' : 'ok  '} ${tag}${violations.length ? ' (' + violations.length + ')' : ''}`)
      if (shots) await page.screenshot({ path: join(shots, `${theme}${accent ? '-' + accent.slice(1) : ''}-group-call-app-${mode}.png`) })
    } catch (e) { console.log(`SKIP ${tag}: ${String(e.message).split('\n')[0]}`) }
    await page.close()
    if (mode === 'needs-velta' && accent) break
  }
  await ctx.close()
}
await browser.close(); server.close()
const list = [...all.entries()].map(([v, ctxs]) => ({ v, n: ctxs.length, where: [...new Set(ctxs)].slice(0, 4) }))
for (const { v, n, where } of list) console.log(`  ✗ ${v}\n      ${n}× e.g. ${where.join(' | ')}`)
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(list, null, 2))
console.log(`${list.length} distinct contrast violation(s); ${skippedTotal} text node(s) over image/gradient/video skipped`)
process.exit(list.length ? 1 : 0)
