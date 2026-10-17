import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { installChatViewGlobals, installFakeDocument } from "./helpers/fake-dom.mjs";

// Regression (06baa36): components.js re-exported escapeHtml/escapeAttr with a
// bare `export { … } from "./format.js"`, which creates no local binding, so
// every <velta-chat-item> render threw a ReferenceError and the chat list
// came up empty on Android.
installChatViewGlobals();
installFakeDocument();
await import("../app/js/components.js");

test("chat list item and chat head render (escaping helpers bound locally)", () => {
  const Item = customElements.get("velta-chat-item");
  const item = new Item();
  item.chat = { id: 5, name: "A<b>", kind: "single", lastMsg: "hi <x>", draft: "", ts: Date.now() };
  let out;
  assert.doesNotThrow(() => { out = JSON.stringify(item.render()); });
  assert.match(out, /A<b>/);
  const Head = customElements.get("velta-chat-head");
  const head = new Head();
  head.chat = { id: 5, name: "A", kind: "single" };
  assert.doesNotThrow(() => head.render());
});

test("no app module uses a name it only re-exports", () => {
  const dir = new URL("../app/js/", import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith(".js"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const m of src.matchAll(/^export \{([^}]*)\} from ["'][^"']+["'];?$/gm)) {
      for (const raw of m[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/).pop();
        if (!name) continue;
        const rest = src.replace(m[0], "");
        const used = new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(rest);
        const imported = new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from`).test(rest);
        assert.ok(!used || imported, `${f} calls ${name} but only re-exports it`);
      }
    }
  }
});

test("About Velta offers the diagnostics log", () => {
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /showAbout\(\{ onDiagnostics, backendKind \}\)/);
  assert.match(ui, /Open diagnostics log/);
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app, /onDiagnostics: async \(\) => \{ await modalHistorySettled\(\); openDiagnosticsChat\(\); \}/);
});
