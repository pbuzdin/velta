#!/usr/bin/env node
// Text contrast of the group call card in every state (Join, Open, Leave,
// Start again, "You're in", sub line) in incoming and outgoing bubbles, for
// the dark / light / brutal themes and a light custom accent (yellow) on
// dark and light. Fails below WCAG AA 4.5:1. docs/agents/group-calls.md.
// The outgoing case moves the demo card's row to .msg-row.out (the CSS
// surface rules are what matter); the joined/ended states are clones of the
// card with the state's buttons shown.
// Usage: node scripts/e2e-group-call-contrast.mjs [--shots DIR]
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const appRoot = fileURLToPath(new URL('../app/', import.meta.url))
const args = process.argv.slice(2)
const shots = (() => { const i = args.indexOf('--shots'); return i >= 0 ? args[i + 1] : null })()
if (shots) mkdirSync(shots, { recursive: true })
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.xdc': 'application/zip', '.webmanifest': 'application/manifest+json' }
const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '')
  const f = join(appRoot, p || 'index.html')
  if (!f.startsWith(appRoot) || !existsSync(f)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/index.html`

let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const toBottom = async (page) => { for (let i = 0; i < 6; i++) { await page.evaluate(() => { for (const e of document.querySelectorAll('*')) if (e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight }); await page.waitForTimeout(300) } }
const shot = async (page, name) => { await page.evaluate(() => document.querySelectorAll('.toasts > *, .toast').forEach((t) => t.remove())).catch(() => {}); await page.locator('.msg-groupcall').first().evaluate((e) => e.scrollIntoView({ block: 'center' })).catch(() => {}); await page.waitForTimeout(200); if (shots) { await page.screenshot({ path: `${shots}/${name}.png` }); console.log(`  shot ${shots}/${name}.png`) } }
const CASES = [
  { name: 'dark', theme: 'dark' }, { name: 'light', theme: 'light' }, { name: 'brutal', theme: 'brutal' },
  { name: 'yellow-dark', theme: 'dark', accent: '#f5d000' }, { name: 'yellow-light', theme: 'light', accent: '#f5d000' },
  { name: 'red-light', theme: 'light', accent: '#e53935' },
]
try {
  for (const c of CASES) {
    for (const side of ['in', 'out']) {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
      await ctx.addInitScript(({ theme, accent }) => { localStorage.setItem('velta-mock', '1'); localStorage.setItem('dw-theme', theme); if (accent) localStorage.setItem('velta-accent', accent) }, c)
      const page = await ctx.newPage()
      page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
      await page.goto(base); await page.waitForSelector('.chat-item', { timeout: 15000 }); await page.waitForTimeout(400)
      await page.locator('.chat-item', { hasText: 'Weekend Crew' }).first().click()
      await page.waitForTimeout(700); await toBottom(page)
      await page.waitForFunction(() => /in call/.test(document.querySelector('.msg-groupcall .gc-sub')?.textContent || ''), null, { timeout: 8000 })
      const res = await page.evaluate((side) => {
        const card = document.querySelector('.msg-groupcall')
        const row = card.closest('.msg-row')
        if (side === 'out') row.classList.add('out'); else row.classList.remove('out')
        const show = (el, sel, on) => el.querySelectorAll(sel).forEach((e) => { e.hidden = !on })
        const joined = card.cloneNode(true); joined.classList.add('gc-joined')
        show(joined, '.gc-join, .gc-ended-label', false); show(joined, '.gc-in, .gc-open, .gc-leave', true)
        const ended = card.cloneNode(true); ended.classList.add('gc-ended')
        show(ended, '.gc-in, .gc-leave', false); show(ended, '.gc-join, .gc-ended-label', true)
        ended.querySelector('.gc-join').textContent = 'Start again'
        card.after(joined); joined.after(ended)
        // contrast
        const parse = (s) => { const m = s.match(/[\d.]+/g).map(Number); if (s.startsWith('color(')) return [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1]; return [m[0], m[1], m[2], m[3] ?? 1] }
        const over = (top, bot) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + bot[i] * (1 - a)).concat(1) }
        const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.backgroundImage !== 'none' && e !== document.documentElement) stack.push(null); const b = parse(cs.backgroundColor); if (b[3] > 0) { stack.push(b); if (b[3] >= 1) break } } let col = [255, 255, 255, 1]; for (const b of stack.reverse()) if (b) col = over(b, col); return col }
        const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
        const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
        const out = []
        for (const [st, el] of [['join', card], ['joined', joined], ['ended', ended]]) {
          for (const t of el.querySelectorAll('.gc-join, .gc-open, .gc-leave, .gc-in, .gc-ended-label, .gc-sub, .gc-title')) {
            if (t.hidden || !t.offsetParent) continue
            const bg = bgOf(t); const fg = over(parse(getComputedStyle(t).color), bg)
            out.push({ st, what: t.textContent.trim().slice(0, 14), r: Math.round(ratio(fg, bg) * 100) / 100 })
          }
        }
        card.scrollIntoView({ block: 'start' })
        return out
      }, side)
      const low = res.filter((x) => x.r < 4.5)
      check(res.length >= 12 && !low.length, `${c.name}/${side}: ${res.length} texts >= 4.5:1 (min ${Math.min(...res.map((x) => x.r))}${low.length ? '; LOW ' + JSON.stringify(low) : ''})`)
      if (shots) { await page.evaluate(() => document.querySelectorAll('.toasts > *, .toast').forEach((t) => t.remove())); await page.waitForTimeout(150); await page.screenshot({ path: `${shots}/join-fix-${c.name}-${side}.png` }) }
      await ctx.close()
    }
  }
} finally { await browser.close(); server.close() }
console.log(failed ? `group call contrast e2e: ${failed} FAILED` : 'group call contrast e2e: all checks passed')
process.exit(failed ? 1 : 0)
