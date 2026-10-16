import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installChatViewGlobals, installFakeDocument, FakeElement } from "./helpers/fake-dom.mjs";
import {
  MEDIA_SECTIONS, MEDIA_ROW_H, mediaRowHeight, MEDIA_BATCH, MEDIA_GRID_COLS, queryChatMedia, filterMedia, mediaItemName,
  mediaRowHtml, mediaTileHtml, mediaSectionsHtml, mountChatMedia, loadMessages,
} from "../app/js/chat-media.js";
import { LruCache } from "../app/js/lru.js";

const VT = { Webxdc: "webxdc", Image: "image", Gif: "image", Sticker: "sticker", Video: "video", Audio: "audio", Voice: "voice", File: "file" };

// Fake core: per-viewtype id lists (oldest first, like the core) + batched loader.
function fakeCore(msgs) {
  const core = {
    mediaCalls: [], batches: [],
    async getChatMedia(chatId, types) {
      core.mediaCalls.push([chatId, ...types]);
      const want = new Set(types.map(t => VT[t]));
      return msgs.filter(m => want.has(m.viewtype)).map(m => m.id);
    },
    async getMessagesByIds(ids) {
      core.batches.push(ids.slice());
      return ids.map(id => msgs.find(m => m.id === id)).filter(Boolean);
    },
  };
  return core;
}

const sample = [
  { id: 1, viewtype: "webxdc", fileName: "poll.xdc", from: 1, ts: 1e12 },
  { id: 2, viewtype: "image", filePath: "blobs/a.jpg", fileName: "a.jpg", fromContact: { name: "Ann" }, ts: 1e12 },
  { id: 3, viewtype: "sticker", filePath: "blobs/s.webp", ts: 1e12 },
  { id: 4, viewtype: "video", filePath: "blobs/v.mp4", duration: 75, ts: 1e12 },
  { id: 5, viewtype: "voice", filePath: "blobs/v.ogg", duration: 9, ts: 1e12 },
  { id: 6, viewtype: "audio", filePath: "blobs/song.mp3", fileName: "song.mp3", ts: 1e12 },
  { id: 7, viewtype: "file", filePath: "blobs/Report.pdf", fileName: "Report.pdf", fileSize: 2048, ts: 1e12 },
  { id: 8, viewtype: "file", filePath: "blobs/notes.txt", fileName: "notes.txt", fileSize: 10, ts: 1e12 },
  { id: 9, viewtype: "text", text: "hi" },
];

test("sections: five, with the core viewtypes per type", () => {
  assert.deepEqual(MEDIA_SECTIONS.map(s => [s.key, s.types]), [
    ["apps", ["Webxdc"]], ["photos", ["Image", "Gif", "Sticker"]], ["videos", ["Video"]],
    ["audio", ["Audio", "Voice"]], ["files", ["File"]],
  ]);
  assert.ok(MEDIA_SECTIONS.every(s => s.types.length <= 3), "get_chat_media takes at most three types");
});

test("media query per type: newest first; missing API degrades to null", async () => {
  const core = fakeCore(sample);
  const got = {};
  for (const s of MEDIA_SECTIONS) got[s.key] = await queryChatMedia(core, 42, s);
  assert.deepEqual(got, { apps: [1], photos: [3, 2], videos: [4], audio: [6, 5], files: [8, 7] });
  assert.deepEqual(core.mediaCalls[1], [42, "Image", "Gif", "Sticker"]);
  assert.equal(await queryChatMedia({}, 42, MEDIA_SECTIONS[0]), null);
});

test("rpc-core forwards to get_chat_media with null padding; mock twin exists", async () => {
  const { RpcCore } = await import("../app/js/rpc-core.js").catch(() => ({}));
  const src = readFileSync(new URL("../app/js/rpc-core.js", import.meta.url), "utf8");
  assert.match(src, /this\._call\("get_chat_media", this\.accountId, chatId, t1, t2, t3\)/);
  assert.match(src, /async getMessagesByIds\(ids = \[\]\)/);
  const mock = readFileSync(new URL("../app/js/mock-core.js", import.meta.url), "utf8");
  assert.match(mock, /async getChatMedia\(chatId, types = \[\]\)/);
  void RpcCore;
});

test("search filtering: names, diacritics-insensitive, manifest name wins for apps", () => {
  const files = sample.filter(m => m.viewtype === "file");
  assert.deepEqual(filterMedia(files, "report").map(m => m.id), [7]);
  assert.deepEqual(filterMedia(files, " ").map(m => m.id), [7, 8]);
  assert.deepEqual(filterMedia([{ id: 1, fileName: "Café.pdf" }], "cafe").map(m => m.id), [1]);
  assert.equal(mediaItemName(sample[0]), "poll");
  assert.equal(mediaItemName(sample[0], { name: "Quick Poll" }), "Quick Poll");
  assert.equal(mediaItemName(sample[4]), "Voice message");
});

test("rows and tiles: escaped, durations, sizes, accessible labels, no custom elements", () => {
  const sec = k => MEDIA_SECTIONS.find(s => s.key === k);
  const file = mediaRowHtml(sec("files"), { ...sample[6], fileName: "<x>.pdf" });
  assert.match(file, /&lt;x&gt;\.pdf/);
  assert.match(file, /2\.0 KB/);
  assert.match(file, /data-media-save aria-label="Save &lt;x&gt;\.pdf"/);
  assert.match(mediaRowHtml(sec("audio"), sample[4]), /data-media-play aria-label="Play Voice message".*00:09/s);
  assert.match(mediaRowHtml(sec("apps"), sample[0]), /media-app-letter[^>]*>P</);
  assert.match(mediaRowHtml(sec("apps"), sample[0], { iconUrl: "x/icon.png" }), /<img class="media-app-icon" src="x\/icon\.png"/);
  assert.match(mediaTileHtml(sec("videos"), sample[3]), /role="img" aria-label="Video.*01:15/s);
  assert.match(mediaTileHtml(sec("photos"), sample[1], { fileUrl: (p, o) => `u/${p}${o?.thumb ? "?w" : ""}` }), /<img class="media-tile-inner" src="u\/blobs\/a\.jpg\?w" alt="Photo, .*Ann" loading="lazy"/);
  assert.match(mediaTileHtml(sec("photos"), { id: 9, downloadState: "Available" }), /not downloaded/);
  const all = [mediaSectionsHtml(), ...MEDIA_SECTIONS.map(s => s.layout === "grid" ? mediaTileHtml(s, sample[3]) : mediaRowHtml(s, sample[6]))].join("");
  // Elena pitfall (e7ecf79): nothing here may be a custom element a host diff could empty.
  assert.doesNotMatch(all, /<[a-z]+-[a-z-]+[\s>]/);
  assert.equal((mediaSectionsHtml().match(/<details /g) || []).length, 5);
  assert.doesNotMatch(mediaSectionsHtml(), / open[\s>]/, "collapsed by default");
});

test("batched loading through the LRU", async () => {
  const many = Array.from({ length: 130 }, (_, i) => ({ id: 100 + i, viewtype: "image", filePath: `p${i}` }));
  const core = fakeCore(many);
  const cache = new LruCache({ maxItems: 400, maxBytes: Infinity, sizeOf: () => 0 });
  const got = await loadMessages(core, many.map(m => m.id), cache);
  assert.equal(got.length, 130);
  assert.deepEqual(core.batches.map(b => b.length), [MEDIA_BATCH, MEDIA_BATCH, 30]);
  await loadMessages(core, [100, 101], cache);
  assert.equal(core.batches.length, 3, "cached ids are not refetched");
});

// Fake chat-info body exposing the [data-media=…] sections.
function fakeRoot() {
  const secs = new Map();
  for (const s of MEDIA_SECTIONS) {
    const el = new FakeElement("details");
    el.hidden = true; el.open = false;
    const count = new FakeElement("span"), body = new FakeElement("div"), summary = new FakeElement("summary");
    el.querySelector = sel => sel === "[data-media-count]" ? count : sel === "[data-media-body]" ? body : sel === "summary" ? summary : null;
    Object.assign(el, { count, body, summary });
    secs.set(s.key, el);
  }
  return { secs, querySelector: sel => secs.get(/data-media="(\w+)"/.exec(sel)?.[1]) || null };
}

test("counts on mount, contents only when first opened, search + open + save", async () => {
  installChatViewGlobals();
  installFakeDocument();
  const core = fakeCore(sample);
  const root = fakeRoot();
  const opened = [], saved = [];
  const { sections, ready } = mountChatMedia(root, { core, chatId: 42, onOpen: (k, m) => opened.push([k, m.id]), onSave: m => saved.push(m.id), appInfo: async () => ({ name: "Quick Poll", icon: "i.png" }), appIconUrl: (id, icon) => `app/${id}/${icon}` });
  await ready;
  const counts = Object.fromEntries([...root.secs].map(([k, el]) => [k, el.count.textContent]));
  assert.deepEqual(counts, { apps: "1", photos: "2", videos: "1", audio: "2", files: "2" });
  assert.ok([...root.secs.values()].every(el => !el.hidden));
  assert.equal(core.batches.length, 0, "no message bodies before a section opens");

  const files = root.secs.get("files");
  files.open = true;
  await files.fire("toggle");
  const ctl = await sections.get("files").open();
  assert.equal(sections.get("files").loads, 1);
  assert.equal(core.batches.length, 1);
  const [search, scroller, empty] = files.body.children;
  const spacer = scroller.children[0];
  assert.equal(ctl.input.getAttribute("aria-label"), "Search files");
  assert.deepEqual(spacer.children.map(r => r.dataset.msgId), ["8", "7"]);
  ctl.input.value = "REPORT";
  await ctl.input.fire("input");
  assert.deepEqual(spacer.children.map(r => r.dataset.msgId), ["7"]);
  assert.equal(search.children[1].hidden, false);
  ctl.input.value = "zzz";
  await ctl.input.fire("input");
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, "No files found");
  await search.children[1].fire("click");
  const row = spacer.children[0];
  await scroller.fire("click", { target: { closest: sel => sel.includes(".media-row") ? row : null } });
  await scroller.fire("click", { target: { closest: sel => sel === "[data-media-save]" ? {} : (sel.includes(".media-row") ? row : null) } });
  assert.deepEqual(opened, [["files", 8]]);
  assert.deepEqual(saved, [8]);
  // re-toggling does not reload
  await files.fire("toggle");
  assert.equal(sections.get("files").loads, 1);

  // apps: manifest name used for display and search
  const apps = root.secs.get("apps");
  apps.open = true;
  await apps.fire("toggle");
  const actl = await sections.get("apps").open();
  actl.input.value = "quick";
  await actl.input.fire("input");
  const appsRow = actl.scroller.children[0].children[0];
  assert.match(appsRow.innerHTML, /Quick Poll/);
  assert.match(appsRow.innerHTML, /src="app\/1\/i\.png"/);
});

test("grid: windowed tiles for a big chat, loaded lazily in batches", async () => {
  installChatViewGlobals();
  installFakeDocument();
  const many = Array.from({ length: 1000 }, (_, i) => ({ id: 1000 + i, viewtype: "image", filePath: `p${i}.jpg`, ts: 1e12 }));
  const core = fakeCore(many);
  const root = fakeRoot();
  const { sections, ready } = mountChatMedia(root, { core, chatId: 1, fileUrl: p => `u/${p}` });
  await ready;
  assert.equal(root.secs.get("photos").count.textContent, (1000).toLocaleString());
  assert.equal(root.secs.get("apps").hidden, false);
  assert.equal(root.secs.get("apps").count.textContent, "0");
  const ctl = await sections.get("photos").open();
  const spacer = ctl.scroller.children[0];
  const tiles = spacer.children.length;
  assert.ok(tiles > 0 && tiles < 100, `only the window is rendered (${tiles})`);
  assert.equal(tiles % MEDIA_GRID_COLS, 0);
  const loaded = core.batches.flat().length;
  assert.ok(loaded <= tiles && loaded > 0, "only visible ids fetched");
  assert.match(spacer.children[0].innerHTML, /<img class="media-tile-inner" src="u\/p999\.jpg"/, "newest first");
});

test("unsupported core (PWA without the gallery call) keeps sections hidden", async () => {
  const root = fakeRoot();
  const { ready } = mountChatMedia(root, { core: {}, chatId: 1 });
  await ready;
  assert.ok([...root.secs.values()].every(el => el.hidden));
});

test("chat info wires the sections for group, channel and 1:1", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app, /chat\.kind === "group" \|\| chat\.kind === "channel" \|\| chat\.kind === "single"\) \? mediaSectionsHtml\(\)/);
  assert.match(app, /mountChatMedia\(body, \{/);
  assert.match(app, /function openChatMediaItem\(kind, m\)/);
});

test("audio rows: fixed height for text + player, same as the virtual row height; no inner scroll", async () => {
  installChatViewGlobals();
  installFakeDocument();
  const audio = MEDIA_SECTIONS.find(s => s.key === "audio");
  assert.ok(mediaRowHeight(audio) >= 72 && mediaRowHeight(audio) <= 80);
  for (const k of ["apps", "files"]) assert.equal(mediaRowHeight(MEDIA_SECTIONS.find(s => s.key === k)), MEDIA_ROW_H);
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  const cssH = Number(/\.media-row-audio \{ height: (\d+)px/.exec(css)?.[1]);
  assert.equal(cssH, mediaRowHeight(audio), "CSS audio row height = virtual list row height");
  assert.match(css, /\.media-row \{ overflow: visible; \}/);
  const root = fakeRoot();
  const { sections, ready } = mountChatMedia(root, { core: fakeCore(sample), chatId: 1 });
  await ready;
  const ctl = await sections.get("audio").open();
  const rows = ctl.scroller.children[0].children;
  assert.deepEqual(rows.map(r => r.style.height), ["80px", "80px"]);
  assert.deepEqual(rows.map(r => r.style.top), ["0px", "80px"]);
  assert.match(rows[0].className, /media-row-audio/);
  assert.equal(ctl.scroller.children[0].style.height, "160px");
});
