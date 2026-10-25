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

// #151: "New group" must let the picker's history entry pop before the
// group-name modal opens — otherwise the pending pop closes the new modal
// instantly and Create appears to do nothing.
test("new-group flow settles the picker's history entry before askGroupName", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app,
    /pickContactModal\("Add group members", true\);[\s\S]{0,400}?await modalHistorySettled\(\);[\s\S]{0,200}?askGroupName\(\)/);
});

// #155: "+" list offers New channel and it creates an outgoing broadcast.
test("new-channel action creates a broadcast channel", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  const rpc = readFileSync(new URL("../app/js/rpc-core.js", import.meta.url), "utf8");
  assert.match(app, /label: "New channel"[\s\S]{0,400}?createChat\([^)]*"channel"\)/);
  assert.match(rpc, /kind === "channel"[\s\S]{0,200}create_broadcast/);
});

// #149: "+" list adds a relay onto the open profile, and that call must
// not require the Relays-modal refresh (a missing one used to throw after
// the relay was already added).
test("deleting a group leaves it before delete_chat (#145)", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  const start = app.indexOf("const membership =");
  assert.ok(start !== -1);
  const body = app.slice(start, start + 1600);
  assert.match(body, /chat\.kind === "group" \|\| chat\.chatType === "OutBroadcast" \|\| chat\.chatType === "InBroadcast"/);
  const leave = body.indexOf("leaveGroup(chat.id).catch(() => {})");
  const del = body.indexOf("deleteChat(chat.id)");
  assert.ok(leave !== -1 && del !== -1 && leave < del, "leave runs, then delete");
  assert.match(app, /chat\.chatType !== "Mailinglist"/);
});

test("the + menu adds a relay to the current account", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app, /label: "Add a relay to this account"[\s\S]{0,160}?addRelayFlow\(core\.accountEpoch\)/);
  const start = app.indexOf("async function addRelayFlow(");
  const body = app.slice(start, app.indexOf("\nasync function ", start + 10));
  assert.match(body, /refresh\?\.\(\)/);
});
