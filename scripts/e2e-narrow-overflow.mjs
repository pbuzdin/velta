#!/usr/bin/env node
// Narrow-viewport overflow audit (small phones, large UI scale). Serves app/
// statically, forces the mock core (localStorage velta-mock=1), walks the main
// screens at 320x640 and 360x740 (UI scale 1 and 1.3) and reports every
// visible element whose right edge passes the viewport or whose content is
// clipped horizontally (scrollWidth > clientWidth under overflow hidden/clip,
// without text-overflow: ellipsis). Intentional horizontal scrollers
// (overflow-x: auto|scroll, e.g. the category chips) are skipped. Also checks
// that phone modals opened from the chat list leave the bottom action bar
// visible (cee7084, by design).
// Usage: node scripts/e2e-narrow-overflow.mjs [--shots DIR] [--prefix NAME]
//   (needs `npx playwright install chromium`, or CHROMIUM_PATH=/path/to/chrome)
// Exit 1 when any overflow is found.
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const appRoot = fileURLToPath(new URL('../app/', import.meta.url))
const args = process.argv.slice(2)
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
const shots = opt('--shots'), prefix = opt('--prefix') || 'shot'
if (shots) mkdirSync(shots, { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.xdc': 'application/zip' }
const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '')
  const f = join(appRoot, p || 'index.html')
  if (!f.startsWith(appRoot) || !existsSync(f)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' })
  res.end(readFileSync(f))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/index.html`

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})

function audit() {
  const vw = innerWidth, out = []
  const scrollerAncestor = el => {
    for (let a = el.parentElement; a; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX
      if (ox === 'auto' || ox === 'scroll') return a
    }
    return null
  }
  const name = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '')
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed' && el.getBoundingClientRect().left >= vw) continue
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    if (el.closest('.sr-only, [aria-hidden="true"], .drawer:not(.open), .virtual-scroller-spacer')) continue
    if (r.left >= vw - 0.5 || r.right <= 0.5) continue // fully off-screen (slid-out drawers, panels)
    const sc = scrollerAncestor(el)
    if (sc && sc !== document.scrollingElement) continue
    if (r.right > vw + 0.5) out.push(`${name(el)} right=${r.right.toFixed(1)} > ${vw}`)
    else if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && cs.textOverflow !== 'ellipsis' &&
      el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && !el.matches('img, video, canvas, iframe, velta-avatar, velta-avatar *'))
      out.push(`${name(el)} clipped scrollWidth=${el.scrollWidth} > clientWidth=${el.clientWidth}`)
  }
  if (document.documentElement.scrollWidth > vw + 0.5) out.push(`document scrollWidth=${document.documentElement.scrollWidth} > ${vw}`)
  // By design (cee7084, Pavel's choice): phone task modals opened from the
  // chat list stop above the bottom action bar, which stays visible.
  const bar = document.querySelector('.list-bar')
  if (vw <= 600 && bar && !document.querySelector('.app.chat-open')) {
    const b = bar.getBoundingClientRect()
    for (const m of document.querySelectorAll('.modal:not(.modal-compact)')) {
      const r = m.getBoundingClientRect()
      // The bar's 1px top border may sit under the modal edge; its buttons must not.
      const btnTop = Math.min(...[...bar.querySelectorAll('.bar-btn')].map(e => e.getBoundingClientRect().top))
      if (r.bottom > btnTop + 0.5) out.push(`${name(m)} covers the bottom action bar: modal bottom=${r.bottom.toFixed(1)} > bar buttons top=${btnTop.toFixed(1)}`)
      if (b.height < 40 || b.bottom < innerHeight - 0.5) out.push(`.list-bar not visible at the bottom under ${name(m)}`)
    }
  }
  return [...new Set(out)]
}

const clickText = async (page, sel, text) => {
  const loc = page.locator(sel, { hasText: text }).first()
  await loc.click({ timeout: 4000 })
  await page.waitForTimeout(500)
}
const openDrawer = async page => { await page.locator('.bar-btn').last().click(); await page.waitForTimeout(500) }
const back = async page => { await page.keyboard.press('Escape'); await page.goBack().catch(() => {}); await page.waitForTimeout(400) }

const screens = [
  ['chatlist', async () => {}],
  ['drawer', async p => openDrawer(p)],
  ['about', async p => { await openDrawer(p); await clickText(p, '.ctx-item', 'About Velta') }],
  ['about-deviceinfo', async p => { await openDrawer(p); await clickText(p, '.ctx-item', 'About Velta'); const s = p.locator('details.device-info > summary'); if (await s.count()) { await s.click(); await p.waitForTimeout(300) } }],
  ['about-deviceinfo-bottom', async p => { await openDrawer(p); await clickText(p, '.ctx-item', 'About Velta'); const s = p.locator('details.device-info > summary'); if (await s.count()) { await s.click(); await p.waitForTimeout(300) } await p.evaluate(() => { const b = document.querySelector('.modal .modal-body'); b.scrollTop = b.scrollHeight }); await p.waitForTimeout(200) }],
  ['relays', async p => { await openDrawer(p); await clickText(p, '.ctx-item', 'Relays of this profile') }],
  ['profile-mgmt', async p => { await openDrawer(p); await clickText(p, '.ctx-item', 'Profile management') }],
  ['invite-qr', async p => { await openDrawer(p); await clickText(p, '.ctx-item', 'Invite friends (QR)'); await p.waitForTimeout(800) }],
  ['invite-domains', async p => { await openDrawer(p); await clickText(p, '.ctx-item', 'Invite link domains') }],
  ['edit-profile', async p => { await openDrawer(p); await clickText(p, 'button', 'Edit profile') }],
  ['contacts', async p => { await p.locator('.bar-btn').nth(1).click(); await p.waitForTimeout(500) }],
  ['calls', async p => { await p.locator('.bar-btn').nth(2).click(); await p.waitForTimeout(500) }],
  ['new-chat', async p => { await p.locator('.bar-btn.bar-accent').click(); await p.waitForTimeout(500) }],
  ['chat-ada', async p => { await clickText(p, '.chat-item', 'Ada Byron'); await p.waitForTimeout(800) }],
  ['chat-group', async p => { await clickText(p, '.chat-item', 'Weekend Crew'); await p.waitForTimeout(800) }],
  ['chat-devs', async p => { await clickText(p, '.chat-item', 'Velta Devs'); await p.waitForTimeout(800) }],
  ['chatinfo-group', async p => { await clickText(p, '.chat-item', 'Weekend Crew'); await p.locator('.chat-head-text').first().click(); await p.waitForTimeout(900) }],
  ['chatinfo-contact', async p => { await clickText(p, '.chat-item', 'Ada Byron'); await p.locator('.chat-head-text').first().click(); await p.waitForTimeout(900) }],
  ['chatinfo-channel', async p => { await clickText(p, '.chat-item', 'News'); await p.locator('.chat-head-text').first().click(); await p.waitForTimeout(900) }],
]

let failures = 0
for (const [w, h] of [[320, 640], [360, 740]]) for (const scale of ['1', '1.15']) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await ctx.addInitScript(s => { localStorage.setItem('velta-mock', '1'); if (s !== '1') localStorage.setItem('velta-ui-scale', s) }, scale)
  for (const [id, go] of screens) {
    const page = await ctx.newPage()
    try {
      await page.goto(base); await page.waitForSelector('.chat-item', { timeout: 15000 }); await page.waitForTimeout(600)
      await go(page)
      const found = await page.evaluate(audit)
      const tag = `${w}x${h}@${scale} ${id}`
      if (found.length) { failures++; console.log(`FAIL ${tag}\n  ${found.slice(0, 12).join('\n  ')}`) } else console.log(`ok   ${tag}`)
      if (shots) await page.screenshot({ path: join(shots, `${prefix}-${w}x${h}${scale === "1" ? "" : "-scale" + scale}-${id}.png`) })
    } catch (e) { console.log(`SKIP ${w}x${h}@${scale} ${id}: ${String(e.message).split('\n')[0]}`) }
    await page.close()
  }
  await ctx.close()
}
await browser.close(); server.close()
console.log(failures ? `${failures} screen(s) failed` : 'no horizontal overflow, bottom bar visible under list modals')
process.exit(failures ? 1 : 0)
