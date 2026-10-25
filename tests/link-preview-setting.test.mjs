import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const { linkPreview, setLinkPreviewProxySource, activeProxyUrl, linkPreviewMode, setLinkPreviewMode, LINK_PREVIEW_IP_WARNING, senderPreviewUrl, receiveFetchesPreview, wrapLines, renderPreviewImage, linkPreviewCardHtml } = await import("../app/js/link-preview.js");

test("link previews are off until a mode is chosen, and the old on is fetch", () => {
  localStorage.removeItem("velta-link-preview");
  assert.equal(linkPreviewMode(), "off");
  localStorage.setItem("velta-link-preview", "0");
  assert.equal(linkPreviewMode(), "off");
  localStorage.setItem("velta-link-preview", "1");
  assert.equal(linkPreviewMode(), "fetch");
  setLinkPreviewMode("picture");
  assert.equal(localStorage.getItem("velta-link-preview"), "picture");
  assert.equal(linkPreviewMode(), "picture");
  setLinkPreviewMode("off");
  assert.equal(localStorage.getItem("velta-link-preview"), null);
  assert.equal(linkPreviewMode(), "off");
});

test("a per-chat override wins, and the warning names the IP leak", () => {
  setLinkPreviewMode("fetch");
  assert.equal(linkPreviewMode(4), "fetch");
  setLinkPreviewMode("picture", 4);
  assert.equal(linkPreviewMode(4), "picture");
  assert.equal(linkPreviewMode(5), "fetch");
  localStorage.setItem("velta-link-preview-chats", JSON.stringify({ 4: "on" }));
  assert.equal(linkPreviewMode(4), "fetch");
  setLinkPreviewMode(null, 4);
  assert.equal(linkPreviewMode(4), "fetch");
  setLinkPreviewMode("picture");
  setLinkPreviewMode("off", 4);
  assert.equal(linkPreviewMode(4), "off");
  assert.equal(linkPreviewMode(5), "picture");
  assert.match(LINK_PREVIEW_IP_WARNING, /IP address/);
  assert.match(LINK_PREVIEW_IP_WARNING, /private or group chat/);
  assert.match(LINK_PREVIEW_IP_WARNING, /edit the page/);
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(ui, /\$\{t\(LINK_PREVIEW_IP_WARNING\)\}/);
  assert.doesNotMatch(ui, /confirmModal\("Link previews"/);
  assert.doesNotMatch(app, /confirmModal\("Link previews"/);
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
  setLinkPreviewProxySource(async () => null);
  setLinkPreviewMode("off");
  assert.equal(await linkPreview("https://example.com/page"), null);
  setLinkPreviewMode("picture");
  assert.equal((await linkPreview("https://example.com/page")).title, "Example");
  setLinkPreviewMode("fetch");
  const fp = "a".repeat(40);
  assert.equal(await linkPreview(`https://deltachat.id/alice`), null);
  assert.equal(await linkPreview(`https://deltachat.id/`), null);
  assert.equal(await linkPreview(`https://i.delta.chat/#${fp}`), null);
  const preview = await linkPreview("https://example.com/page");
  assert.equal(preview.title, "Example");
  assert.deepEqual(calls.map(c => c.args.url), ["https://example.com/page"]);
  const cv = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  assert.match(cv, /linkPreviewMode\(chatId\) === "fetch"/);
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

test("the sent picture signs Velta and the live card does not", () => {
  const bake = renderPreviewImage.toString();
  assert.match(bake, /Sent with Velta/);
  assert.match(bake, /600 16px/);
  assert.match(bake, /#1c1c26/);
  assert.match(bake, /rgba\(15,15,20,0\.78\)/);
  assert.doesNotMatch(linkPreviewCardHtml.toString(), /Sent with Velta/);
});

test("wrapLines breaks on the measure, and keeps a single word", () => {
  const measure = s => s.length;
  assert.deepEqual(wrapLines("one two three", 7, measure), ["one two", "three"]);
  assert.deepEqual(wrapLines("hello", 3, measure), ["hello"]);
  assert.deepEqual(wrapLines("", 10, measure), []);
});

test("the configured proxy is passed to the shell fetch, and an unknown one blocks it", async () => {
  const calls = [];
  globalThis.window.__TAURI__ = {
    core: { invoke(cmd, args) { calls.push({ cmd, args }); return Promise.resolve({ title: "T" }); } },
  };
  setLinkPreviewMode("fetch");
  const tunnel = "socks5://velta-tunnel:pw@127.0.0.1:41234";
  setLinkPreviewProxySource(async () => tunnel);
  assert.equal((await linkPreview("https://proxied.example/a")).title, "T");
  assert.deepEqual(calls.at(-1), { cmd: "fetch_link_preview", args: { url: "https://proxied.example/a", proxy: tunnel } });

  // No reader registered, or a reader that fails: no fetch at all (never
  // direct), and nothing cached so a later render retries.
  calls.length = 0;
  setLinkPreviewProxySource(null);
  assert.equal(await linkPreview("https://unknown.example/a"), null);
  setLinkPreviewProxySource(async () => { throw new Error("rpc down"); });
  assert.equal(await linkPreview("https://unknown.example/a"), null);
  assert.equal(calls.length, 0);
  setLinkPreviewProxySource(async () => null);
  assert.equal((await linkPreview("https://unknown.example/a")).title, "T");
  assert.deepEqual(calls, [{ cmd: "fetch_link_preview", args: { url: "https://unknown.example/a", proxy: null } }]);
});

test("activeProxyUrl follows proxy_enabled and takes the first list entry", () => {
  assert.equal(activeProxyUrl("1", "socks5://a:1"), "socks5://a:1");
  assert.equal(activeProxyUrl("1", "\n socks5://a:1 \nhttp://b:2"), "socks5://a:1");
  assert.equal(activeProxyUrl("0", "socks5://a:1"), null);
  assert.equal(activeProxyUrl(null, "socks5://a:1"), null);
  assert.equal(activeProxyUrl("1", ""), null);
  assert.equal(activeProxyUrl("1", null), null);
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app, /setLinkPreviewProxySource\(/);
  assert.match(app, /getConfig\("proxy_enabled"\)/);
  assert.match(app, /getConfig\("proxy_url"\)/);
  const rs = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(rs, /async fn fetch_link_preview\(url: String, proxy: Option<String>\)/);
  assert.match(rs, /link_preview_agent\(proxy\.as_deref\(\)\)\?/);
});

test("page title and invite expansion share fetch_capped and the proxy policy", () => {
  const rs = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(rs, /async fn fetch_page_title\(url: String, proxy: Option<String>\)/);
  assert.match(rs, /async fn expand_invite_link\(url: String, proxy: Option<String>\)/);
  assert.equal((rs.match(/fetch_capped\(&agent, &url\)/g) || []).length, 3);
  assert.equal((rs.match(/take\(256 \* 1024\)/g) || []).length, 1);
  for (const f of ["inapp-browser.js", "invites.js"]) {
    const js = readFileSync(new URL(`../app/js/${f}`, import.meta.url), "utf8");
    assert.match(js, /shellProxy\(\)/, f);
  }
});
