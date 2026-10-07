import test from "node:test";
import assert from "node:assert/strict";

// link-preview.js pulls the UI module graph, which extends HTMLElement.
class Element {}
globalThis.HTMLElement = Element;
globalThis.customElements = { get() {}, define() {} };
globalThis.document = { getElementById() { return null; }, createElement: () => new Element() };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const store = {};
globalThis.localStorage = {
  getItem(k) { return Object.hasOwn(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; },
};

const { linkPreview, linkPreviewEnabled, setLinkPreviewEnabled, LINK_PREVIEW_IP_WARNING, senderPreviewUrl, receiveFetchesPreview, wrapLines } = await import("../app/js/link-preview.js");

test("link previews are off until the user opts in", () => {
  localStorage.removeItem("velta-link-preview");
  assert.equal(linkPreviewEnabled(), false);
  // The previous default stored "off" as "0" and treated a missing key as on.
  localStorage.setItem("velta-link-preview", "0");
  assert.equal(linkPreviewEnabled(), false);
  setLinkPreviewEnabled(true);
  assert.equal(localStorage.getItem("velta-link-preview"), "1");
  assert.equal(linkPreviewEnabled(), true);
  setLinkPreviewEnabled(false);
  assert.equal(localStorage.getItem("velta-link-preview"), null);
  assert.equal(linkPreviewEnabled(), false);
});

test("a per-chat override wins, and the warning names the IP leak", () => {
  setLinkPreviewEnabled(false);
  assert.equal(linkPreviewEnabled(4), false);
  setLinkPreviewEnabled(true, 4);
  assert.equal(linkPreviewEnabled(4), true);
  assert.equal(linkPreviewEnabled(5), false);
  setLinkPreviewEnabled(null, 4);
  assert.equal(linkPreviewEnabled(4), false);
  assert.match(LINK_PREVIEW_IP_WARNING, /IP address/);
  assert.match(LINK_PREVIEW_IP_WARNING, /private or group chat/);
  assert.match(LINK_PREVIEW_IP_WARNING, /edit the page/);
});

test("deltachat.id and invite links are not fetched", async () => {
  const calls = [];
  globalThis.window.__TAURI__ = {
    core: {
      invoke(cmd, args) {
        calls.push({ cmd, args });
        return Promise.resolve({ title: "Example" });
      },
    },
  };
  setLinkPreviewEnabled(true);
  const fp = "a".repeat(40);
  assert.equal(await linkPreview(`https://deltachat.id/alice`), null);
  assert.equal(await linkPreview(`https://deltachat.id/`), null);
  assert.equal(await linkPreview(`https://i.delta.chat/#${fp}`), null);
  const preview = await linkPreview("https://example.com/page");
  assert.equal(preview.title, "Example");
  assert.deepEqual(calls.map(c => c.args.url), ["https://example.com/page"]);
});

test("sender preview attaches only for a finished https url with no file", () => {
  const on = { enabled: true };
  assert.equal(senderPreviewUrl("https://example.com/a", on), "https://example.com/a");
  assert.equal(senderPreviewUrl("see [docs](https://example.com/a)", on), "https://example.com/a");
  assert.equal(senderPreviewUrl("https://example.com/a", { enabled: false }), null);
  assert.equal(senderPreviewUrl("https://example.com/a", { enabled: true, hasFile: true }), null);
  assert.equal(senderPreviewUrl("https://example.com/a", { enabled: true, dismissed: "https://example.com/a" }), null);
  assert.equal(senderPreviewUrl("https://example.com/b", { enabled: true, dismissed: "https://example.com/a" }), "https://example.com/b");
  assert.equal(senderPreviewUrl("https://deltachat.id/x", on), null);
  assert.equal(senderPreviewUrl("https://e", on), null);
  assert.equal(senderPreviewUrl("http://example.com/a", on), null);
  const fp = "a".repeat(40);
  assert.equal(senderPreviewUrl(`https://i.delta.chat/#${fp}`, on), null);
});

test("a photo caption does not fetch a preview", () => {
  assert.equal(receiveFetchesPreview("text"), true);
  assert.equal(receiveFetchesPreview(undefined), true);
  assert.equal(receiveFetchesPreview("image"), false);
  assert.equal(receiveFetchesPreview("file"), false);
  assert.equal(receiveFetchesPreview("video"), false);
});

test("wrapLines breaks on the measure, and keeps a single word", () => {
  const measure = s => s.length;
  assert.deepEqual(wrapLines("one two three", 7, measure), ["one two", "three"]);
  assert.deepEqual(wrapLines("hello", 3, measure), ["hello"]);
  assert.deepEqual(wrapLines("", 10, measure), []);
});
