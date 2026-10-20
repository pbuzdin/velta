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

// Velta Beam + Velta Circle (webxdc): each bundles its own velta-tokens.css,
// generated from main.css; the apps' own CSS uses var(--…) only.
const XDC = ["send-direct", "group-call"];
test("webxdc velta-tokens.css copies match main.css (run node tools/build-builtin-xdc.mjs)", async () => {
  const { xdcTokensCss } = await import("../tools/build-builtin-xdc.mjs");
  for (const app of XDC) assert.equal(read(`app/webxdc/${app}/velta-tokens.css`), xdcTokensCss(), `${app}/velta-tokens.css is stale`);
});
test("webxdc apps: tokens stylesheet linked and bundled, no raw colors or font sizes in their CSS/JS", async () => {
  const { buildSendDirect, buildGroupCall } = await import("../tools/build-builtin-xdc.mjs");
  for (const [app, build] of [["send-direct", buildSendDirect], ["group-call", buildGroupCall]]) {
    const html = read(`app/webxdc/${app}/index.html`);
    assert.match(html, /<link rel="stylesheet" href="velta-tokens.css">/, app);
    assert.ok(build().includes(Buffer.from("velta-tokens.css")), `${app}.xdc bundles velta-tokens.css`);
    const style = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n");
    for (const { sel, body } of rules(style)) for (const decl of body.split(";")) {
      const d = decl.trim();
      if (!d || d.startsWith("--")) continue;
      assert.doesNotMatch(d, RAW, `${app}: ${sel} { ${d} }`);
      if (/^font(-size)?\s*:/.test(d) && !/^font:\s*inherit/.test(d) && !(app === "group-call" && sel.startsWith(".av"))) assert.match(d, /var\(--/, `${app}: ${sel} { ${d} }`);
    }
  }
  const js = read("app/webxdc/send-direct/ui.js").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(js, RAW_JS, "send-direct/ui.js");
});
test("webxdc apps: velta.cc call-to-action only outside Velta, link + selectable text, no a7", () => {
  for (const app of XDC) {
    const html = read(`app/webxdc/${app}/index.html`);
    assert.match(html, /<a href="https:\/\/velta\.cc" target="_blank" rel="noopener">velta\.cc<\/a>/, app);
    assert.match(html, /\.cta[^{]*\{[^}]*user-select: text/, app);
    for (const f of [`app/webxdc/${app}/index.html`, app === "group-call" ? "app/webxdc/group-call/main.js" : "app/webxdc/send-direct/ui.js"])
      assert.doesNotMatch(read(f), /a7\.velta/, f);
  }
  assert.match(read("app/webxdc/send-direct/index.html"), /id="velta-cta" hidden/);
  assert.match(read("app/webxdc/send-direct/ui.js"), /typeof wx\.veltaCall === "object"/);
  // Circle: centered row right below the "needs Velta" notice, shown only with it
  assert.match(read("app/webxdc/group-call/index.html"), /id="needs-velta" hidden>[^]*?<\/div>\s*<p class="cta" id="velta-cta" hidden>Get Velta · <a/);
  assert.match(read("app/webxdc/group-call/main.js"), /\$\("velta-cta"\)\.hidden = false/);
});
