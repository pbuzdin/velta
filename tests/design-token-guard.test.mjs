// Design-token guard (design audit 2026-10-20): the UI areas reworked onto
// tokens must not regrow raw colors. Colors live only in custom-property
// definitions (`--x: #...`); declarations in these rules use var(--…).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const RAW = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
// JS: hsl() is the shared name-color.js avatar hue (the app mirrors it).
const RAW_JS = /#[0-9a-f]{3,8}\b|\brgba?\(/i;
const AREAS = ["#call-overlay", ".call-", "#call-remote", "#group-call-bar", ".gcb-", ".msg-groupcall", ".gc-",
  ".ca-", ".device-info", ".settings-diff", ".msg-settings-act", ".md-note", ".msg-fwd", ".msg-meta",
  ".q-name", ".webxdc-frame", ".call-card"];

function rules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  // flatten @media: take innermost "selector { body }" pairs
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ sel: m[1].trim(), body: m[2] });
  return out;
}

test("touched main.css areas use tokens only (no raw hex/rgb/hsl outside --token definitions)", () => {
  const bad = [];
  for (const { sel, body } of rules(read("app/css/main.css"))) {
    if (!AREAS.some(a => sel.includes(a))) continue;
    for (const decl of body.split(";")) {
      const d = decl.trim();
      if (!d || d.startsWith("--")) continue;
      if (RAW.test(d)) bad.push(`${sel} { ${d} }`);
    }
  }
  assert.deepEqual(bad, [], "raw colors:\n" + bad.join("\n"));
});

test("calls / group-call JS sets no raw colors", () => {
  for (const f of ["app/js/calls.js", "app/js/group-call-ui.js", "app/webxdc/group-call/main.js"]) {
    const code = read(f).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, RAW_JS, f);
  }
});

test("group-call app: raw colors only inside its :root token fallback block", () => {
  const html = read("app/webxdc/group-call/index.html");
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ""])[1];
  for (const { sel, body } of rules(style)) {
    if (sel === ":root") continue;
    for (const decl of body.split(";")) {
      const d = decl.trim();
      if (d && !d.startsWith("--")) assert.doesNotMatch(d, RAW, `${sel} { ${d} }`);
    }
  }
});

test("no var() hex fallbacks: every token is defined", () => {
  const css = read("app/css/main.css");
  assert.doesNotMatch(css, /var\(--[a-z0-9-]+,\s*#/i);
});
