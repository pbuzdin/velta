import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// article.js pulls the link-preview graph, which extends HTMLElement.
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

const { formatArticleMessage, parseArticleMessage, articleCardHtml } = await import("../app/js/article.js");

const OPENING = "The extracted opening is long enough to stand as the message body for a chat card today.";

test("format and parse round-trip, and a short note is not a card", () => {
  const msg = formatArticleMessage({ title: "Hello & Co", opening: OPENING, url: "https://www.example.com/a" });
  const parsed = parseArticleMessage(msg);
  assert.equal(parsed.title, "Hello & Co");
  assert.equal(parsed.opening, OPENING);
  assert.equal(parsed.url, "https://www.example.com/a");
  assert.equal(parseArticleMessage("hi\n\nhttps://example.com/x"), null);
  assert.equal(parseArticleMessage("see this\n\nhttps://example.com/x"), null);
  const withLink = "See https://other.example/a inside this extracted opening that is still one paragraph of prose.";
  const msg2 = formatArticleMessage({ title: "T", opening: withLink, url: "https://example.com/b" });
  assert.equal(parseArticleMessage(msg2).url, "https://example.com/b");
  assert.match(parseArticleMessage(msg2).opening, /other\.example/);
  assert.equal(formatArticleMessage({ title: "T", opening: "short", url: "https://example.com/a" }), null);
  assert.equal(formatArticleMessage({ title: "T", opening: OPENING, url: "http://example.com/a" }), null);
  const titled = formatArticleMessage({ title: "https://nope.example/x", opening: OPENING, url: "https://www.example.com/a" });
  assert.equal(parseArticleMessage(titled).title, "example.com");
});

test("a paragraph that is only a URL is not the opening", () => {
  const msg = [
    "Hello",
    "https://only.example/x",
    OPENING,
    "https://example.com/a",
  ].join("\n\n");
  assert.equal(parseArticleMessage(msg), null);
});

test("the card shows the title and Read, and the ghost has no live link", () => {
  const a = parseArticleMessage(formatArticleMessage({ title: "Hello", opening: OPENING, url: "https://example.com/a" }));
  const html = articleCardHtml(a);
  assert.match(html, /Hello/);
  assert.match(html, /data-act="read-article"/);
  assert.match(html, />Read</);
  assert.match(html, /href="https:\/\/example\.com\/a"/);
  assert.doesNotMatch(html, /msg-webxdc/);
  const ghost = articleCardHtml(a, { link: false });
  assert.doesNotMatch(ghost, /<a /);
  assert.match(ghost, /data-act="open-article"/);
});

test("chat-view sends an article as text and does not fetch to paint it", () => {
  const src = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  const lp = readFileSync(new URL("../app/js/link-preview.js", import.meta.url), "utf8");
  assert.match(src, /if \(tauriInvoke\(\)\) \{\s*attachItems\.push\(\{ label: "Send article"/);
  const textAt = src.indexOf("if (m.text && !article)");
  const cardAt = src.indexOf("else if (article)");
  const callAt = src.indexOf('else if (m.viewtype === "call")', cardAt);
  assert.ok(textAt > 0 && textAt < cardAt && cardAt < callAt);
  assert.match(src.slice(textAt, cardAt), /data-lp/);
  const card = src.slice(cardAt, callAt);
  assert.match(card, /articleCardHtml\(article\)/);
  assert.doesNotMatch(card, /data-lp|fetchArticle|fetch_article/);
  const href = src.indexOf('const link = e.target.closest("a[href]")');
  const read = src.lastIndexOf("[data-read-link]", href);
  assert.ok(read > 0 && read < href);
  assert.match(src, /parseArticleMessage\(text\) \? null : senderPreviewUrl/);
  assert.match(html, /id="article-draft"/);
  assert.doesNotMatch(lp, /data-read-link|read-article/);
});

test("Send article: attach menu and link-preview ghost card, shell only (#252)", async () => {
  const { readFileSync } = await import("node:fs");
  const r = f => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const cv = r("app/js/chat-view.js"), html = r("app/index.html");
  assert.match(cv, /label: "Send article", icon: ICO\.article/);
  assert.match(html, /id="btn-lp-article"[^>]*hidden/);
  assert.match(cv, /btn-lp-article"\)\?\.addEventListener\("click", \(\) => this\._composeArticle\(\)\)/);
  assert.match(cv, /sendArticle\.hidden = !tauriInvoke\(\)/);
  for (const l of ["ru", "fr"]) assert.ok(JSON.parse(r(`app/locales/${l}.json`))["Send article"], l);
});
