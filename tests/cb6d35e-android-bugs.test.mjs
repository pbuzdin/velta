import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installChatViewGlobals, installFakeDocument, FakeElement } from "./helpers/fake-dom.mjs";

installChatViewGlobals();
installFakeDocument();
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// ---- 1. Videos grid: square px tiles, centred SVG glyph, poster frame -----
const media = await import("../app/js/chat-media.js");

test("videos: square tiles sized from the box width, same as photos", () => {
  assert.equal(media.gridTileSize(328), 82);
  assert.equal(media.gridTileSize(0), 80); // before layout: fallback, re-laid out later
  const videos = media.MEDIA_SECTIONS.find(s => s.key === "videos");
  const html = media.mediaTileHtml(videos, { id: 4, filePath: "v.mp4", duration: 75, ts: 1e12 }, { fileUrl: p => `u/${p}` });
  assert.doesNotMatch(html, /▶/, "no emoji-prone glyph");
  assert.match(html, /media-play-glyph" aria-hidden="true"><svg /);
  assert.match(html, /<video class="media-poster" src="u\/v\.mp4#t=0\.1" preload="metadata" muted playsinline/);
  assert.match(html, /media-dur">01:15</);
  assert.doesNotMatch(media.mediaTileHtml(videos, { id: 5, downloadState: "Available" }), /<video/, "no poster until downloaded");
  const css = src("app/css/main.css");
  // .media-tile .media-tile-inner (display:block) used to beat .media-video
  // (display:grid), so the glyph sat at the top instead of centred.
  assert.match(css, /\.media-tile \.media-video \{ position: relative; display: grid; place-items: center;/);
  assert.match(css, /\.media-video \.media-poster \{ position: absolute; inset: 0;[^}]*object-fit: cover/);
});

test("videos: mounted grid uses px squares and re-lays out when the width changes", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: 1 + i, viewtype: "video", filePath: `v${i}.mp4`, ts: 1e12 }));
  const core = {
    async getChatMedia(c, t) { return t.includes("Video") ? many.map(m => m.id) : []; },
    async getMessagesByIds(ids) { return many.filter(m => ids.includes(m.id)); },
  };
  const secs = new Map();
  for (const s of media.MEDIA_SECTIONS) {
    const el = new FakeElement("details"), count = new FakeElement(), body = new FakeElement();
    el.querySelector = sel => sel === "[data-media-count]" ? count : sel === "[data-media-body]" ? body : null;
    secs.set(s.key, el);
  }
  const root = { querySelector: sel => secs.get(/data-media="(\w+)"/.exec(sel)?.[1]) || null };
  const { sections, ready } = media.mountChatMedia(root, { core, chatId: 1 });
  await ready;
  const ctl = await sections.get("videos").open();
  const spacer = ctl.scroller.children[0];
  const t = spacer.children[5];
  assert.equal(t.style.width, "80px");
  assert.equal(t.style.height, "80px");
  assert.equal(t.style.left, "80px");
  assert.equal(t.style.top, "80px");
  ctl.scroller.clientWidth = 360;
  await ctl.render();
  const t2 = spacer.children.find(n => n.dataset.index === "5");
  assert.equal(t2.style.width, "90px");
  assert.equal(t2.style.height, "90px");
  assert.equal(t2.style.top, "90px");
});

// ---- 2. Outgoing (recorded) audio: now covered by tests/audio-player.test.mjs
// (5276656's seek trick was not enough on Android: the native control stayed
// a pill until first play, so the chat draws its own player).

// ---- 3. Webxdc cards: cold-start info retry + built-in Velta Beam ---------
const wx = await import("../app/js/webxdc-manager.js");

test("cold start: first get_webxdc_info calls fail, later success hydrates the card", async () => {
  let calls = 0;
  const core = new EventTarget();
  core.accountId = 1;
  core.getWebxdcInfo = async () => {
    calls++;
    if (calls <= 2) throw new Error("account not ready");
    return { name: "Poll", icon: "icon.png" };
  };
  wx.initWebxdc(core);
  const waits = [];
  const info = await wx.loadInfoWithRetry(777, { delays: [1, 2, 4], wait: async ms => { waits.push(ms); } });
  assert.equal(info.name, "Poll");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1, 2], "kept retrying past the old single retry");
  // failures were not cached as the generic fallback
  assert.equal((await wx.prefetchInfo(777)).name, "Poll");
});

test("delayed core: gives up quietly when the card goes away", async () => {
  const core = new EventTarget();
  core.getWebxdcInfo = async () => { throw new Error("busy"); };
  wx.initWebxdc(core);
  let alive = true, n = 0;
  const info = await wx.loadInfoWithRetry(778, { delays: [1, 1, 1, 1], alive: () => alive, wait: async () => { if (++n === 2) alive = false; } });
  assert.equal(info, null);
});

test("built-in Velta Beam card: bundled name and icon for send-direct*.xdc", () => {
  for (const f of ["send-direct.xdc", "send-direct-3.xdc", "SEND-DIRECT.xdc"]) {
    const b = wx.builtinAppCard(f);
    assert.equal(b.name, "Velta Beam");
    assert.match(b.iconUrl, /\/app\/webxdc\/send-direct\/icon\.png$/);
  }
  assert.equal(wx.builtinAppCard("poll.xdc"), null);
  const s = src("app/js/chat-view.js");
  assert.match(s, /const appName = builtin\?\.name \|\| \(m\.fileName/);
  assert.match(s, /loadInfoWithRetry\(m\.id, \{ alive:/);
  assert.match(s, /iconImg\.onerror = showLetter;/, "a failed icon URL falls back to the letter tile");
  assert.doesNotMatch(s, /setTimeout\(\(\) => \{ if \(alive\(\) && webxdcCard\.isConnected\) loadInfo\(1\)/);
});
