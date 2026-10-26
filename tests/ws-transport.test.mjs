// WebSocket transport (Android/Windows): URL + link validation, list
// rendering, actions and the link confirm flow. The shell side (SOCKS5,
// framing, store, a local bridge integration test) is Rust:
// velta-app/src-tauri/src/ws_transport.rs.
import test from "node:test";
import assert from "node:assert/strict";

const m = await import("../app/js/ws-transport.js");
const { classifyScannedCode } = await import("../app/js/qr-actions.js");

test("proxy URLs are normalized strictly", () => {
  assert.equal(m.normalizeWsProxyUrl("proxy.example.org"), "wss://proxy.example.org");
  assert.equal(m.normalizeWsProxyUrl(" WSS://Proxy.Example.org/ "), "wss://proxy.example.org");
  assert.equal(m.normalizeWsProxyUrl("wss://proxy.example.org:443/ws/"), "wss://proxy.example.org/ws");
  assert.equal(m.normalizeWsProxyUrl("wss://proxy.example.org:8443"), "wss://proxy.example.org:8443");
  assert.equal(m.normalizeWsProxyUrl("ws://127.0.0.1:8153"), "ws://127.0.0.1:8153");
  assert.equal(m.normalizeWsProxyUrl("wss://[2001:db8::2]:444"), "wss://[2001:db8::2]:444");
  for (const bad of ["", "ws://proxy.example.org", "https://proxy.example.org", "wss://u:p@proxy.example.org",
    "wss://proxy.example.org/?a=1", "wss://proxy.example.org/#x", "wss://proxy.example.org:0", "wss://proxy.example.org:70000",
    "wss://proxy.example.org:", "wss://bad_host.example.org", "wss://nodot", "wss://a b.example.org", "wss://proxy.example.org/a/../b",
    "javascript:alert(1)", "wss://" + "a".repeat(600) + ".org"]) {
    assert.throws(() => m.normalizeWsProxyUrl(bad), undefined, bad);
  }
});

test("velta://ws links round-trip and reject junk", () => {
  const link = m.buildWsLink({ url: "proxy.example.org/ws", label: "Office & home" });
  assert.equal(link, "velta://ws?u=wss%3A%2F%2Fproxy.example.org%2Fws&n=Office%20%26%20home");
  assert.deepEqual(m.parseWsLink(link), { url: "wss://proxy.example.org/ws", label: "Office & home" });
  assert.equal(m.extractWsLink(` ${link} `), link);
  assert.equal(m.extractWsLink("velta://wsx?u=a"), null);
  assert.equal(m.extractWsLink("velta://tunnel?zone=x"), null);
  assert.equal(classifyScannedCode(link, { parseInviteLink: () => null, isShortInviteLink: () => false }), "tunnel");
  for (const bad of ["velta://ws?", "velta://ws?n=x", "velta://ws?u=wss://a.example.org&u=wss://b.example.org",
    "velta://ws?u=wss://a.example.org&x=1", "velta://ws?u=%E0%A4%A", "velta://ws?u=http://a.example.org",
    "velta://ws?u=wss://a.example.org&n=" + "x".repeat(1100)]) {
    assert.throws(() => m.parseWsLink(bad), undefined, bad);
  }
  assert.equal(m.parseWsLink("velta://ws?u=wss://a.example.org&n=%0Aevil%07").label, "evil");
});

test("test host: configured server, else the address domain", () => {
  assert.equal(m.testHostFor({ mailServer: "IMAP.example.org.", addr: "a@b.example.org" }), "imap.example.org");
  assert.equal(m.testHostFor({ mailServer: "", addr: "a@chat.example.org" }), "chat.example.org");
  assert.equal(m.testHostFor({}), "");
});

test("platform notes", () => {
  assert.equal(m.wsTransportPlatform({ tauri: true, status: { supported: true } }).supported, true);
  const mac = m.wsTransportPlatform({ tauri: true, status: { supported: false } });
  assert.equal(mac.supported, false);
  assert.match(mac.text, /Android and Windows/);
  assert.match(m.wsTransportPlatform({ tauri: false }).text, /web app already/);
  assert.equal(m.wsDrawerLabel({ supported: true, active: null, proxies: [] }), "Off");
  assert.equal(m.wsDrawerLabel({ supported: true, active: "a", proxies: [{ id: "a", url: "wss://p.example.org", label: "" }] }), "p.example.org");
  assert.equal(m.wsDrawerLabel(null), "Not available");
});

test("list rows are escaped and keyboard-reachable buttons with labels", () => {
  const html = m.wsListHtml({ active: "a1", proxies: [
    { id: "a1", url: "wss://p.example.org", label: "<b>x</b>" },
    { id: "b2\"><script>", url: "wss://q.example.org", label: "" },
  ] });
  assert.ok(!html.includes("<b>x</b>") && html.includes("&lt;b&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.match(html, /data-act="off" aria-label="Stop using/);
  assert.match(html, /data-act="use" aria-label="Use q\.example\.org"/);
  assert.equal((html.match(/<button type="button"/g) || []).length, 8);
  assert.match(m.wsListHtml({ proxies: [] }), /No saved proxies/);
});

function shell() {
  const calls = [];
  let st = { supported: true, active: null, proxies: [{ id: "a1", url: "wss://p.example.org", label: "Home" }] };
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    switch (cmd) {
      case "ws_transport_status": return st;
      case "ws_transport_select": st = { ...st, active: args.id }; return null;
      case "ws_transport_delete": st = { ...st, proxies: st.proxies.filter(p => p.id !== args.id) }; return null;
      case "ws_transport_add": st.proxies.push({ id: "n1", url: args.url, label: args.label }); if (args.activate) st.active = "n1"; return { id: "n1", existing: false };
      case "ws_transport_test": if (args.host === "down.example.org") throw new Error("proxy timed out"); return { ips: 2, ms: 40 };
    }
    throw new Error("unknown " + cmd);
  };
  return { calls, invoke, get st() { return st; } };
}
const ui = () => {
  const out = { toasts: [], errs: [] };
  out.toast = s => out.toasts.push(s);
  out.errToast = s => out.errs.push(s);
  return out;
};

test("use / off / test / delete with confirm", async () => {
  const sh = shell(); const u = ui();
  const p = sh.st.proxies[0];
  let changed = 0;
  const deps = { invoke: sh.invoke, toast: u.toast, errToast: u.errToast, onChange: () => changed++, testHost: "imap.example.org" };
  assert.equal(await m.wsAction("use", p, deps), true);
  assert.equal(sh.st.active, "a1");
  assert.equal(m.wsTransportStatus().active, "a1");
  await m.wsAction("test", p, deps);
  assert.deepEqual(sh.calls.at(-1), ["ws_transport_test", { url: "wss://p.example.org", host: "imap.example.org" }]);
  assert.match(u.toasts.at(-1), /works: imap\.example\.org found/);
  await m.wsAction("test", p, { ...deps, testHost: "down.example.org" });
  assert.match(u.errs.at(-1), /doesn't answer: proxy timed out/);
  await m.wsAction("test", p, { ...deps, testHost: "" });
  assert.match(u.errs.at(-1), /no mail server/);
  // Declined confirm: nothing deleted.
  assert.equal(await m.wsAction("delete", { ...p, active: true }, { ...deps, confirmModal: async (title, text) => { assert.match(text, /in use/); return false; } }), false);
  assert.equal(sh.st.proxies.length, 1);
  assert.equal(await m.wsAction("delete", p, { ...deps, confirmModal: async () => true }), true);
  assert.equal(sh.st.proxies.length, 0);
  assert.equal(await m.wsAction("off", p, deps), true);
  assert.equal(sh.st.active, null);
  assert.ok(changed >= 3);
  let shared = null;
  await m.wsAction("share", p, { ...deps, shareText: async s => { shared = s; } });
  assert.equal(shared, "velta://ws?u=wss%3A%2F%2Fp.example.org&n=Home");
});

test("a velta://ws link is confirmed with the traffic warning before use", async () => {
  const sh = shell(); const u = ui();
  let shown = null;
  const link = m.buildWsLink({ url: "wss://new.example.org", label: "Friend" });
  assert.equal(await m.acceptWsLink(link, { invoke: sh.invoke, toast: u.toast, errToast: u.errToast, confirmModal: async (ti, text) => { shown = text; return false; } }), false);
  assert.match(shown, /All chat traffic will go through this WebSocket proxy/);
  assert.match(shown, /new\.example\.org/);
  assert.ok(!sh.calls.some(c => c[0] === "ws_transport_add"));
  assert.equal(await m.acceptWsLink(link, { invoke: sh.invoke, toast: u.toast, errToast: u.errToast, confirmModal: async () => true }), true);
  assert.deepEqual(sh.calls.find(c => c[0] === "ws_transport_add")[1], { url: "wss://new.example.org", label: "Friend", activate: true });
  // Bad link: no dialog at all.
  assert.equal(await m.acceptWsLink("velta://ws?u=http://x.example.org", { invoke: sh.invoke, toast: u.toast, errToast: u.errToast, confirmModal: async () => { throw new Error("no"); } }), false);
  assert.match(u.errs.at(-1), /can't be used/);
  // Unsupported desktop shell: refused with the platform note.
  const mac = async cmd => (cmd === "ws_transport_status" ? { supported: false } : null);
  assert.equal(await m.acceptWsLink(link, { invoke: mac, toast: u.toast, errToast: u.errToast, confirmModal: async () => true }), false);
  assert.match(u.errs.at(-1), /Android and Windows/);
});

test("drawer entry is wired and only for native shells", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app, /onWsTransport: window\.__TAURI__/);
  const uiSrc = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.match(uiSrc, /data-act="ws-transport"/);
  const man = readFileSync(new URL("../velta-app/src-tauri/gen/android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  assert.match(man, /android:scheme="velta" android:host="ws"/);
});
