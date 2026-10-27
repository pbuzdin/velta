// Shared icon module (icon cleanup 2026-10): one source per glyph, house style.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ICON, P, svg, labelled } from "../app/js/icons.js";

const src = f => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const jsFiles = readdirSync(new URL("../app/js/", import.meta.url)).filter(f => f.endsWith(".js") && f !== "icons.js" && f !== "mock-core.js");

test("every shared icon uses the house style", () => {
  for (const [k, s] of Object.entries(ICON)) {
    assert.match(s, /^<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">/, k);
    assert.doesNotMatch(s, /stroke-width="(?!2")/, k);
  }
});

test("labelled() turns a decorative icon into a labelled status image", () => {
  const s = labelled(svg(P.pin, "ci-pin"), "Pinned");
  assert.match(s, /role="img" aria-label="Pinned"/);
  assert.doesNotMatch(s, /aria-hidden/);
});

test("ICO-style duplicates come from icons.js, not inline copies", () => {
  const sigs = { close: "M6 6l12 12M18 6L6 18", copy: "M5 15V5a2 2 0 012-2h10", globe: "M3 12h18M12 3a14", phone: "M6.6 10.8a15.1", oldPin: "M9 4h6l1 7", oldTick2: "735 490" };
  for (const f of jsFiles) {
    const s = src(`app/js/${f}`);
    for (const [k, sig] of Object.entries(sigs)) {
      // calls.js: the full-screen call controls keep their filled glyphs on round discs.
      if (k === "phone" && f === "calls.js") continue;
      assert.ok(!s.includes(sig), `${f} inlines ${k}`);
    }
  }
  assert.ok(!src("app/index.html").includes("M9 4h6l1 7"));
});

test("attach menu: Video and Camera have their own icons; Beam keeps the velta.cc mark", () => {
  const cv = src("app/js/chat-view.js");
  assert.match(cv, /label: "Video", icon: ICO\.video/);
  assert.match(cv, /label: "Camera", icon: ICO\.camera/);
  assert.match(cv, /video: ICON\.video,/);
  assert.match(cv, /camera: ICON\.camera,/);
  assert.notEqual(ICON.video, ICON.photo);
  assert.notEqual(ICON.camera, ICON.photo);
});

test("chat header call/video buttons are outline", () => {
  const html = src("app/index.html");
  assert.ok(!/<svg[^>]*><path d="M6\.6 10\.8[^"]*" fill="currentColor"/.test(html));
  assert.ok(!html.includes('rx="2.2" fill="currentColor"'));
});

test("no text glyph icons in UI buttons", () => {
  for (const f of jsFiles) {
    const code = src(`app/js/${f}`).split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.doesNotMatch(code, />✕<|"✓|"✗|`✗/, f);
  }
});

test("no stray non-house stroke widths in app icons", () => {
  for (const f of [...jsFiles.map(f => `app/js/${f}`), "app/index.html"]) {
    assert.doesNotMatch(src(f), /viewBox="0 0 24 24"[^`'\n]*stroke-width="(1\.6|1\.9|2\.2|2\.4|2\.6|3\.2)"/, f);
  }
});

test("no inline 24-grid icons outside icons.js (except deliberate exceptions)", () => {
  // Left inline on purpose: brand marks (Beam, Circle), the dynamic sending ring,
  // the call-control helper, the white-on-dim video play disc, avatars/QR.
  const allowed = { "chat-view.js": 2, "components.js": 1, "calls.js": 1, "chat-media.js": 1 };
  for (const f of jsFiles) {
    const n = (src(`app/js/${f}`).match(/<svg[^>]*viewBox="0 0 24 24"/g) || []).length;
    assert.ok(n <= (allowed[f] || 0), `${f} has ${n} inline 24-grid <svg>`);
  }
  const html = src("app/index.html");
  assert.doesNotMatch(html, /<svg(?! data-icon=)/);
  for (const [, k] of html.matchAll(/<svg data-icon="(\w+)"/g)) assert.ok(P[k], `index.html icon ${k}`);
});

test("drawer icons are pure outline (no filled shapes); QR/invite share one outline glyph", () => {
  const ui = src("app/js/ui.js");
  const start = ui.indexOf('<div class="drawer-items">'), end = ui.indexOf('<div class="drawer-foot"');
  const used = new Set([...ui.slice(start, end).matchAll(/ICON\.(\w+)/g)].map(m => m[1]));
  assert.ok(used.has("invite") && used.has("imageQuality"));
  for (const k of used) assert.doesNotMatch(P[k], /fill="currentColor"/, k);
  assert.equal(P.invite, P.qr);
  // only Invite friends shows a QR: no other drawer glyph reuses the finder squares
  for (const k of used) if (k !== "invite") assert.ok(!P[k].includes('width="7" height="7"'), k);
});
