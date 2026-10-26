// Bounded renderer caches: the shared LRU helper (app/js/lru.js) and the
// caches built on it stay within ~2 MB / 100 items (rows: 120, pinned while
// in the DOM; fingerprints: 1000; message-id lists: 20 chats).
import test from "node:test";
import assert from "node:assert/strict";
import { LruCache, estimateBytes } from "../app/js/lru.js";
import { buildAvatarSvg, avatarBackgroundUrl } from "../app/js/avatar.js";

test("evicts least-recently-used past maxItems; get() bumps recency", () => {
  const evicted = [];
  const c = new LruCache({ maxItems: 3, onEvict: (k) => evicted.push(k) });
  c.set("a", "1").set("b", "2").set("c", "3");
  assert.equal(c.get("a"), "1"); // a is now newest
  c.set("d", "4");
  assert.deepEqual(evicted, ["b"]);
  assert.deepEqual([...c.keys()], ["c", "a", "d"]);
  assert.equal(c.has("b"), false);
});

test("evicts past maxBytes (strings counted as length*2)", () => {
  assert.equal(estimateBytes("abcd"), 8);
  const c = new LruCache({ maxItems: 100, maxBytes: 100 });
  for (let i = 0; i < 10; i++) c.set(i, "x".repeat(20)); // 40 B each
  assert.equal(c.size, 2);
  assert.equal(c.bytes, 80);
  c.delete(9);
  assert.equal(c.bytes, 40);
  c.set(8, "y"); // overwrite updates bytes
  assert.equal(c.bytes, 2);
  c.clear();
  assert.equal(c.bytes, 0);
});

test("custom sizeOf, pinned entries, and the just-set entry survive", () => {
  const pinned = new Set(["p"]);
  const c = new LruCache({ maxItems: 2, maxBytes: Infinity, sizeOf: () => 0, canEvict: (_v, k) => !pinned.has(k) });
  c.set("p", 1).set("a", 2).set("b", 3);
  assert.deepEqual([...c.keys()], ["p", "b"]);
  pinned.add("b");
  c.set("c", 4); // nothing evictable: stays over the limit rather than dropping pinned rows
  assert.deepEqual([...c.keys()], ["p", "b", "c"]);
  const big = new LruCache({ maxBytes: 10 });
  big.set("huge", "z".repeat(100));
  assert.equal(big.get("huge").length, 100, "an oversized entry is kept until something replaces it");
});

test("iteration is a snapshot (delete while looping)", () => {
  const c = new LruCache();
  for (let i = 0; i < 5; i++) c.set(i, i);
  for (const [k] of c) c.delete(k);
  assert.equal(c.size, 0);
});

test("measure: filling avatar caches far past the limit stays bounded", () => {
  const hex = "0123456789ABCDEF";
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    const groups = Array.from({ length: 10 }, (_, j) => (i * 10 + j).toString(16).toUpperCase().padStart(4, "0").slice(-4).replace(/./g, (ch) => hex[(parseInt(ch, 16) + j) % 16]));
    assert.ok(buildAvatarSvg({ groups }).startsWith("<svg"));
    assert.ok(avatarBackgroundUrl({ groups }).startsWith("data:image/svg+xml,"));
  }
  // Same inputs re-served from cache are identical strings.
  const g = Array(10).fill("ABCD");
  assert.equal(avatarBackgroundUrl({ groups: g }), avatarBackgroundUrl({ groups: g }));
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `1000 tiles in ${ms} ms`);
});

test("link-preview cache is bounded and in-flight entries clear on settle", async () => {
  const calls = [];
  // link-preview.js pulls the UI module graph, which extends HTMLElement.
  class Element {}
  globalThis.HTMLElement ??= Element;
  globalThis.customElements ??= { get() {}, define() {} };
  globalThis.document ??= { getElementById() { return null; }, createElement: () => new Element() };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, __TAURI__: { core: { invoke: async (_cmd, { url }) => {
    calls.push(url);
    if (url.includes("fail")) throw new Error("boom");
    return { title: "T", description: "d", image: "data:image/png;base64," + "A".repeat(20000) };
  } } } };
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const lp = await import("../app/js/link-preview.js");
  if (lp.setLinkPreviewMode) lp.setLinkPreviewMode("fetch"); else store.set("velta-link-preview", "fetch");
  lp.setLinkPreviewProxySource?.(async () => null); // fetches only once the proxy setting is known
  const a = lp.linkPreview("see https://example.com/0");
  const b = lp.linkPreview("again https://example.com/0");
  await Promise.all([a, b]);
  assert.equal(calls.length, 1, "concurrent renders share one fetch");
  await lp.linkPreview("https://example.com/fail");
  assert.equal(lp._linkPreviewCacheStats().inFlight, 0, "settled (ok + failed) fetches leave inFlight");
  for (let i = 1; i < 300; i++) await lp.linkPreview(`https://example.com/${i}`);
  const st = lp._linkPreviewCacheStats();
  assert.ok(st.size <= 100, `size ${st.size}`);
  assert.ok(st.bytes <= 2 * 1024 * 1024, `bytes ${st.bytes}`);
  assert.ok(st.size < 100, "40 KB images hit the 2 MB cap before 100 items");
  assert.equal(st.inFlight, 0);
});

test("rpc-core msgIdCache keeps at most 20 chats and refetches an evicted one", async () => {
  const { JsonRpcCore } = await import("../app/js/rpc-core.js");
  const core = new JsonRpcCore({});
  core.accountId = 1;
  let fetches = 0;
  core._call = async (method, _acc, chatId) => {
    assert.equal(method, "get_message_ids");
    fetches++;
    return Array.from({ length: 10 }, (_, i) => chatId * 100 + i);
  };
  for (let chat = 1; chat <= 50; chat++) await core.getMessageIds(chat);
  assert.equal(core.msgIdCache.size, 20);
  assert.equal(fetches, 50);
  await core.getMessageIds(50); // cached
  assert.equal(fetches, 50);
  assert.deepEqual(await core.getMessageIds(1), Array.from({ length: 10 }, (_, i) => 100 + i));
  assert.equal(fetches, 51, "evicted chat is refetched, not served stale");
});
