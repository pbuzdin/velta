import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { wantsPanel } from "../app/js/webxdc-panel.js";
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("only Velta Beam (or an explicit opt-in) opens as a panel", () => {
  assert.equal(wantsPanel("Velta Beam"), true);
  assert.equal(wantsPanel("Some game"), false);
  assert.equal(wantsPanel("Some game", { panel: true }), true);
});

test("panel wiring: no reload, no history entry, accessible controls", () => {
  const mgr = src("app/js/webxdc-manager.js");
  // reopening the open app keeps the frame
  assert.match(mgr, /active\?\.msgId === Number\(msgId\) && document\.getElementById\("webxdc-overlay"\)/);
  // expand/collapse toggles classes only — the iframe is never re-appended or re-pointed
  const fn = mgr.slice(mgr.indexOf("function applyExpanded"), mgr.indexOf("export function setWebxdcExpanded"));
  assert.ok(!/iframe|appendChild|\.src\s*=/.test(fn));
  assert.match(mgr, /aria-expanded="false" title="Expand to full screen" aria-label="Expand to full screen"/);
  assert.match(mgr, /wrap\.setAttribute\("role", "region"\)/);
  assert.match(mgr, /if \(active\.panel\) \{ if \(isWebxdcExpanded\(\)\) applyExpanded\(false\); return; \}/);
  const css = src("app/css/main.css");
  assert.match(css, /--webxdc-panel-h: min\(max\(220px, calc\(var\(--dvh\) \* \.30\)\), 45%\)/);
  assert.match(css, /flex: 0 0 var\(--webxdc-panel-h\)/);
  assert.ok(!/webxdc-panel-open/.test(css + mgr), "no overlay shrink of the app shell any more");
  // in flow under the chat header, inserted once
  assert.match(mgr, /document\.querySelector\("#chat-view > \.chat-head"\)/);
  assert.match(mgr, /if \(chatHead\) chatHead\.after\(wrap\);/);
  const cv = src("app/js/chat-view.js");
  assert.match(cv, /openWebxdc\(msg\.id, "Velta Beam", \{ panel: true \}\)/);
  assert.match(cv, /panel: \/\^send-direct/);
});

test("renamed to Velta Beam; ids and filenames kept", () => {
  assert.match(src("app/webxdc/send-direct/manifest.toml"), /^name = "Velta Beam"$/m);
  assert.match(src("app/js/chat-view.js"), /prepareBuiltinXdc\("send-direct"/);
  const icon = readFileSync(new URL("../app/webxdc/send-direct/icon.png", import.meta.url));
  assert.equal(icon.readUInt32BE(16), 512);
  assert.equal(icon.readUInt32BE(20), 512);
  const svg = src("app/webxdc/send-direct/icon.svg");
  assert.match(svg, /<rect width="1024" height="1024" rx="208" fill="#0a1020"\/>/);
  assert.match(svg, /<rect x="199" y="221" width="626" height="63"\/>/);
  assert.match(src("app/js/chat-view.js"), /beam: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 4\.17L20 4\.17/);
});
