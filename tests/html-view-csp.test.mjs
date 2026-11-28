import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { HTML_VIEW_CSP, HTML_VIEW_LINK_JS, prepareHtmlView } from "../app/js/html-view.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("viewer policy hashes exactly the injected link script", () => {
  const hash = createHash("sha256").update(HTML_VIEW_LINK_JS).digest("base64");
  assert.ok(HTML_VIEW_CSP.includes(`'sha256-${hash}'`));
  for (const f of ["../app/index.html", "../velta-app/src-tauri/tauri.conf.json", "../velta-app/src-tauri/tauri.android.conf.json"]) {
    assert.ok(read(f).includes(`sha256-${hash}`), f);
  }
});

test("srcdoc carries the policy before any mail content", () => {
  const out = prepareHtmlView("<html><head><title>x</title></head><body><img src=\"https://example.org/p.png\"></body></html>", true);
  const csp = out.indexOf('http-equiv="Content-Security-Policy"');
  assert.ok(csp > 0 && csp < out.indexOf("<title>") && csp < out.indexOf("example.org"));
  assert.match(HTML_VIEW_CSP, /^default-src 'none'/);
  assert.doesNotMatch(HTML_VIEW_CSP, /https?:|\*/);
  assert.match(HTML_VIEW_CSP, /frame-src 'none'/);
});

test("document without a head still gets the policy first", () => {
  const out = prepareHtmlView("<p>hello</p>", false);
  assert.ok(out.startsWith('<meta http-equiv="Content-Security-Policy"'));
  assert.ok(out.endsWith("<p>hello</p>"));
});

test("refresh meta tags are dropped", () => {
  const out = prepareHtmlView('<head><meta http-equiv="refresh" content="0;url=https://example.org/"></head>', true);
  assert.doesNotMatch(out, /refresh/i);
  const out2 = prepareHtmlView("<META HTTP-EQUIV=Refresh CONTENT='1'><p>x</p>", true);
  assert.doesNotMatch(out2, /refresh/i);
});

test("viewer never navigates its frame to a url", () => {
  const src = read("../app/js/chat-view.js");
  const start = src.indexOf("_openHtmlOverlay(titleText");
  const body = src.slice(start, src.indexOf("/* ================= scrolling", start));
  assert.doesNotMatch(body, /frame\.src\s*=/);
  assert.doesNotMatch(body, /setAttribute\(\s*["']src["']/);
  assert.match(body, /frame\.srcdoc\s*=/);
});
