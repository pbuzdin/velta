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
  assert.deepEqual(m.parseWsLink(link), { url: "wss://proxy.example.org/ws", label: "Office & home", token: "" });
  assert.equal(m.extractWsLink(` ${link} `), link);
  assert.equal(m.extractWsLink("velta://wsx?u=a"), null);
  assert.equal(m.extractWsLink("velta://tunnel?zone=x"), null);
  assert.equal(classifyScannedCode(link, { parseInviteLink: () => null, isShortInviteLink: () => false }), "tunnel");
  for (const bad of ["velta://ws?", "velta://ws?n=x", "velta://ws?u=wss://a.example.org&u=wss://b.example.org",
    "velta://ws?u=wss://a.example.org&x=1", "velta://ws?u=%E0%A4%A", "velta://ws?u=http://a.example.org",
    "velta://ws?u=wss://a.example.org&n=" + "x".repeat(2100)]) {
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
  assert.deepEqual(sh.calls.at(-1), ["ws_transport_test", { url: "wss://p.example.org", host: "imap.example.org", token: null }]);
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
  assert.deepEqual(sh.calls.find(c => c[0] === "ws_transport_add")[1], { url: "wss://new.example.org", label: "Friend", token: null, activate: true });
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

const TOK = "eyJ2IjoxLCJpIjoiYWFhMTExIn0." + "A".repeat(42) + "w";

test("invite tokens in velta://ws links", () => {
  assert.ok(m.validWsToken(TOK));
  for (const bad of ["", "abc", "a.b", "eyJ2.short", TOK + "=", TOK.replace(".", ".."), "eyJ 2." + "A".repeat(43), "x".repeat(1000) + "." + "A".repeat(43)]) {
    assert.equal(m.validWsToken(bad), false, bad);
  }
  const link = m.buildWsLink({ url: "proxy.example.org", label: "Mum", token: TOK });
  assert.equal(link, `velta://ws?u=wss%3A%2F%2Fproxy.example.org&n=Mum&t=${TOK}`);
  assert.deepEqual(m.parseWsLink(link), { url: "wss://proxy.example.org", label: "Mum", token: TOK });
  assert.equal(m.parseWsLink(`velta://ws?t=${TOK}&u=wss%3A%2F%2Fp.example.org`).token, TOK, "any field order");
  assert.equal(m.buildWsLink({ url: "proxy.example.org", token: "junk" }), "velta://ws?u=wss%3A%2F%2Fproxy.example.org", "a bad token is never shared");
  for (const bad of [`velta://ws?u=wss://a.example.org&t=`, `velta://ws?u=wss://a.example.org&t=junk`, `velta://ws?u=wss://a.example.org&t=${TOK}&t=${TOK}`]) {
    assert.throws(() => m.parseWsLink(bad), undefined, bad);
  }
});

test("401 reads as a refused invite; list marks proxies with an invite", () => {
  assert.ok(m.isInviteRefusal("invite refused (401): invalid, expired or revoked"));
  assert.ok(m.isDeviceLimit("invite device limit (403): this invite has reached its device limit"));
  assert.equal(m.isDeviceLimit("invite refused (401): invalid, expired or revoked"), false);
  assert.ok(m.isInviteRefusal(new Error("proxy refused the WebSocket: HTTP/1.1 401 Unauthorized")));
  assert.equal(m.isInviteRefusal("proxy timed out"), false);
  const html = m.wsListHtml({ active: null, proxies: [{ id: "a1", url: "wss://p.example.org", label: "Home", token: TOK }, { id: "a2", url: "wss://q.example.org", label: "", token: TOK }] });
  assert.match(html, /p\.example\.org · with invite/);
  assert.match(html, /With invite/);
  assert.ok(!html.includes(TOK), "the token itself is never rendered");
});

test("test sends the token, share warns first, add stores it", async () => {
  const sh = shell(); const u = ui();
  const p = { ...sh.st.proxies[0], token: TOK };
  const refuse = async (cmd, args) => { if (cmd === "ws_transport_test") throw "invite refused (401): invalid, expired or revoked"; return sh.invoke(cmd, args); };
  await m.wsAction("test", p, { invoke: sh.invoke, toast: u.toast, errToast: u.errToast, testHost: "imap.example.org" });
  assert.deepEqual(sh.calls.at(-1), ["ws_transport_test", { url: "wss://p.example.org", host: "imap.example.org", token: TOK }]);
  await m.wsAction("test", p, { invoke: refuse, toast: u.toast, errToast: u.errToast, testHost: "imap.example.org" });
  assert.match(u.errs.at(-1), /refused the invite\. It is invalid, expired or revoked/);
  let shared = null, warned = null;
  const share = { invoke: sh.invoke, toast: u.toast, errToast: u.errToast, shareText: async s => { shared = s; } };
  await m.wsAction("share", p, { ...share, confirmModal: async (ti, text) => { warned = text; return false; } });
  assert.match(warned, /Anyone who gets it can send traffic through this proxy/);
  assert.equal(shared, null, "declined: nothing shared");
  await m.wsAction("share", p, { ...share, confirmModal: async () => true });
  assert.equal(shared, `velta://ws?u=wss%3A%2F%2Fp.example.org&n=Home&t=${TOK}`);
  let shown = null;
  const link = m.buildWsLink({ url: "wss://new.example.org", label: "Friend", token: TOK });
  assert.equal(await m.acceptWsLink(link, { invoke: sh.invoke, toast: u.toast, errToast: u.errToast, confirmModal: async (ti, text) => { shown = text; return true; } }), true);
  assert.match(shown, /includes an invite/);
  assert.deepEqual(sh.calls.find(c => c[0] === "ws_transport_add")[1], { url: "wss://new.example.org", label: "Friend", token: TOK, activate: true });
});

test("PWA: an invite link adds the relay with its token and reloads", async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  globalThis.window ??= {};
  const u = ui();
  let reloaded = 0, shown = null;
  const link = m.buildWsLink({ url: "wss://ws.example.org", label: "Office", token: TOK });
  assert.equal(await m.acceptWsLinkPwa(m.parseWsLink(link), { confirmModal: async (ti, text) => { shown = text; return true; }, toast: u.toast, errToast: u.errToast, reload: () => reloaded++ }), true);
  assert.match(shown, /Mail in this browser will go through this proxy/);
  const r = await import("../app/js/ws-relays.js");
  assert.equal(r.activeWsRelay(), "ws.example.org");
  assert.equal(r.wsProxyUrl(), "wss://ws.example.org");
  assert.equal(r.wsProxyToken(), TOK);
  const dev = r.wsProxyDevice();
  assert.ok(r.validWsDevice(dev) && dev.length === 22, dev);
  assert.equal(r.wsProxyDevice(), dev, "stable per browser and proxy");
  assert.equal(r.wsRelayDevice("other.example.org") === dev, false, "a different id for another proxy");
  assert.deepEqual(r.wsProtocolsFor("wss://ws.example.org/dns/x.example.org"), ["velta.v1", `tok.${TOK}`, `dev.${dev}`]);
  assert.equal(r.wsProxyDevice("wss://other.example.org"), "", "no device id without an invite");
  assert.equal(r.wsProtocolsFor("wss://other.example.org/dns/x"), undefined);
  await new Promise(res => setTimeout(res, 450));
  assert.equal(reloaded, 1);
  // No token, or a port/path the PWA can't use: refused with the platform note.
  assert.equal(await m.acceptWsLinkPwa(m.parseWsLink("velta://ws?u=wss%3A%2F%2Fws.example.org"), { confirmModal: async () => true, toast: u.toast, errToast: u.errToast }), false);
  assert.equal(await m.acceptWsLinkPwa(m.parseWsLink(`velta://ws?u=wss%3A%2F%2Fws.example.org%3A8443&t=${TOK}`), { confirmModal: async () => true, toast: u.toast, errToast: u.errToast }), false);
  assert.match(u.errs.at(-1), /web app already sends mail/);
  // Removing the relay forgets its token.
  r.addWsRelay("b.example.org");
  r.removeWsRelay("ws.example.org");
  assert.equal(r.wsRelayToken("ws.example.org"), "");
});

test("worker offers the invite as a subprotocol only to the proxy", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../app/js/worker-wasm.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function installWsInvite"), src.indexOf("\nself.onmessage"));
  const installWsInvite = new Function(`${fn}; return installWsInvite;`)();
  const made = [];
  class Native { constructor(url, protocols) { made.push([url, protocols]); } }
  Native.OPEN = 1;
  const scope = { WebSocket: Native };
  assert.equal(installWsInvite(scope, "wss://ws.example.org/", "bad token!"), false);
  const scope2 = { WebSocket: Native };
  installWsInvite(scope2, "wss://ws.example.org", TOK, "D".repeat(22));
  new scope2.WebSocket("wss://ws.example.org/tcp/192.0.2.1/993");
  assert.deepEqual(made.pop(), ["wss://ws.example.org/tcp/192.0.2.1/993", ["velta.v1", `tok.${TOK}`, `dev.${"D".repeat(22)}`]]);
  installWsInvite(scope2, "wss://ws.example.org", TOK, "bad, dev.x");
  new scope2.WebSocket("wss://ws.example.org/dns/x");
  assert.deepEqual(made.pop()[1], ["velta.v1", `tok.${TOK}`], "a malformed device id is dropped");
  assert.equal(installWsInvite(scope, "wss://ws.example.org/", TOK), true);
  const a = new scope.WebSocket("wss://ws.example.org/tcp/192.0.2.1/993");
  new scope.WebSocket("wss://ws.example.org.evil.example/dns/x");
  new scope.WebSocket("wss://ws.example.org/dns/x", ["chat"]);
  assert.ok(a instanceof Native);
  assert.equal(scope.WebSocket.OPEN, 1);
  assert.deepEqual(made, [
    ["wss://ws.example.org/tcp/192.0.2.1/993", ["velta.v1", `tok.${TOK}`]],
    ["wss://ws.example.org.evil.example/dns/x", undefined],
    ["wss://ws.example.org/dns/x", ["chat"]],
  ]);
  assert.match(src, /if \(d\.wsProxyToken\) installWsInvite\(self, d\.wsProxyUrl, d\.wsProxyToken, d\.wsProxyDevice\)/);
});
