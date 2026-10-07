import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const store = {};
globalThis.localStorage = {
  getItem(k) { return Object.hasOwn(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; },
};

const { stripTrackingUrl, stripTrackingText, setTrackingStripEnabled, trackingStripEnabled } = await import("../app/js/trackers.js");

const fp = "a".repeat(40);

test("known trackers drop and real params stay", () => {
  assert.equal(stripTrackingUrl("https://example.com/?utm_source=x&id=1"), "https://example.com/?id=1");
  assert.equal(stripTrackingUrl("https://example.com/a?UTM_SOURCE=x"), "https://example.com/a");
  assert.equal(stripTrackingUrl("https://example.com/?utm_source=x#h"), "https://example.com/#h");
  assert.equal(stripTrackingUrl("https://example.com/?id=1&s=2&t=3&si=1&tag=x"), "https://example.com/?id=1&s=2&t=3&si=1&tag=x");
  assert.equal(stripTrackingUrl("https://youtu.be/abc?si=1"), "https://youtu.be/abc");
  assert.equal(stripTrackingUrl("https://www.amazon.com/dp/1?tag=aff"), "https://www.amazon.com/dp/1");
  assert.equal(stripTrackingUrl("https://x.com/a/status/1?s=1&t=2&id=9"), "https://x.com/a/status/1?id=9");
  assert.equal(stripTrackingUrl(`https://i.delta.chat/?utm_source=x#${fp}`), `https://i.delta.chat/?utm_source=x#${fp}`);
  assert.equal(stripTrackingUrl("mailto:a@b.com?utm_source=x"), "mailto:a@b.com?utm_source=x");
  assert.equal(stripTrackingUrl("openpgp4fpr:" + fp), "openpgp4fpr:" + fp);
});

test("paste rewrite follows the drawer switch", () => {
  setTrackingStripEnabled(true);
  assert.equal(trackingStripEnabled(), true);
  const on = stripTrackingText("see https://example.com/?utm_source=x&id=1.");
  assert.equal(on.text, "see https://example.com/?id=1.");
  assert.equal(on.changed, true);
  setTrackingStripEnabled(false);
  assert.equal(trackingStripEnabled(), false);
  const off = stripTrackingText("see https://example.com/?utm_source=x&id=1.");
  assert.equal(off.changed, false);
  assert.equal(off.text, "see https://example.com/?utm_source=x&id=1.");
  setTrackingStripEnabled(true);
});

test("the drawer checkbox and the open/paste paths share the stripper", () => {
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  const cv = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  const lp = readFileSync(new URL("../app/js/link-preview.js", import.meta.url), "utf8");
  assert.match(ui, /data-toggle="strip-trackers"/);
  assert.match(ui, /setTrackingStripEnabled/);
  assert.match(ui, /toast-undo/);
  assert.match(cv, /stripTrackingText/);
  assert.match(cv, /function openHttp/);
  assert.match(lp, /image\/webp/);
});
