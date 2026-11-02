// Saved SOCKS5 proxies (several, one or none active): link flow, list rows,
// and list actions. The shell-side store (proxies.json) is covered by Rust
// unit tests (velta-app/src-tauri/src/proxy_store.rs).
import test from "node:test";
import assert from "node:assert/strict";

const { acceptProxyLink, proxyListHtml, proxyAction, refreshProxyStatus, describeProxy, proxyName, openProxyShare } = await import("../app/js/proxy.js");

const LINK = "velta://proxy?v=1&h=proxy.example.org&p=1080&n=Office";

/** Fake shell with a saved list. */
function shell({ proxies = [], active = null } = {}) {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    switch (cmd) {
      case "proxy_status": {
        const a = proxies.find(x => x.id === active);
        return { installed: proxies.length > 0, available: true, count: proxies.length, active: a ? a.id : null, active_label: a?.label ?? null, host: a?.host };
      }
      case "proxy_list": return { active, proxies: proxies.map(x => ({ ...x, active: x.id === active })) };
      case "proxy_select": active = args.id; return null;
      case "proxy_delete": proxies = proxies.filter(x => x.id !== args.id); if (active === args.id) active = null; return null;
      case "proxy_rename": proxies = proxies.map(x => (x.id === args.id ? { ...x, label: args.label } : x)); return null;
      case "proxy_install": return null;
      case "proxy_link": return { host: "proxy.example.org", port: 1080, user: "", pass: "", label: "Office" };
      default: return null;
    }
  };
  return { invoke, calls, get active() { return active; }, get proxies() { return proxies; } };
}

const P1 = { id: "p1", label: "Home", host: "a.example.org", port: 1080, user: "", has_pass: false, added: 1_700_000_000 };
const P2 = { id: "p2", label: "", host: "192.168.1.10", port: 9050, user: "me", has_pass: true, added: 1_700_000_100 };
const ui = (over = {}) => ({ toast() {}, errToast: e => assert.fail(String(e)), confirmModal: async () => true, ...over });

test("link flow: Add / Add and use / Cancel", async () => {
  for (const [pick, activate] of [["use", true], ["add", false], [null, undefined]]) {
    const sh = shell({ proxies: [P1], active: "p1" });
    let asked; let toastMsg = "";
    const ok = await acceptProxyLink(LINK, { ...ui({ toast: m => { toastMsg = m; } }), choose: async (...a) => { asked = a; return pick; }, invoke: sh.invoke });
    assert.equal(asked[0], "Add SOCKS5 proxy?");
    assert.deepEqual(asked[2].map(a => a.id), ["add", "use"]);
    assert.match(asked[1], /Name: Office/);
    assert.match(asked[1], /proxy in use \(Home\)/);
    const install = sh.calls.find(c => c[0] === "proxy_install");
    if (pick === null) {
      assert.equal(ok, false); assert.equal(install, undefined);
    } else {
      assert.equal(ok, true);
      assert.deepEqual(install[1], { host: "proxy.example.org", port: 1080, user: "", password: "", label: "Office", activate });
      assert.equal(toastMsg, activate ? "SOCKS5 proxy added and in use" : "SOCKS5 proxy added");
    }
  }
});

test("link flow: a duplicate (same server+user) is only offered for activation", async () => {
  const dup = { id: "p2", label: "", host: "proxy.example.org", port: 1080, user: "", has_pass: false, added: 1_700_000_100 };
  const sh = shell({ proxies: [P1, dup], active: "p1" });
  let asked, chose = false;
  const ok = await acceptProxyLink(LINK, { ...ui({ confirmModal: async (...a) => { asked = a; return true; } }), choose: async () => { chose = true; return "use"; }, invoke: sh.invoke });
  assert.equal(ok, true);
  assert.equal(chose, false, "no Add dialog for a saved proxy");
  assert.equal(asked[0], "Use saved proxy?");
  assert.match(asked[1], /already saved as “proxy\.example\.org”/);
  assert.ok(!sh.calls.some(c => c[0] === "proxy_install"));
  assert.deepEqual(sh.calls.find(c => c[0] === "proxy_select")[1], { id: "p2" });
  assert.equal(sh.active, "p2");
});

test("link flow: the duplicate already in use just says so", async () => {
  const dup = { ...P1, host: "proxy.example.org" };
  const sh = shell({ proxies: [dup], active: "p1" });
  let msg = "", asked = false;
  const ok = await acceptProxyLink(LINK, { ...ui({ toast: m => { msg = m; }, confirmModal: async () => { asked = true; return true; } }), invoke: sh.invoke });
  assert.equal(ok, true); assert.equal(asked, false);
  assert.match(msg, /already saved and in use \(Home\)/);
  assert.ok(!sh.calls.some(c => ["proxy_install", "proxy_select"].includes(c[0])));
});

test("list rows: active marker in text, named accessible buttons, escaping", () => {
  const html = proxyListHtml({ active: "p1", proxies: [{ ...P1, active: true }, { ...P2, label: "<img src=x>", active: false }] });
  assert.match(html, /data-id="p1" aria-current="true"/);
  assert.match(html, /In use/);
  assert.equal((html.match(/aria-current/g) || []).length, 1);
  assert.match(html, /aria-label="Stop using Home"/);
  assert.match(html, /aria-label="Use &lt;img src=x&gt;"/);
  for (const a of ["Rename Home", "Share Home", "Delete Home"]) assert.match(html, new RegExp(`aria-label="${a}"`));
  assert.ok(!html.includes("<img src=x>"));
  assert.match(html, /with username and password/); // P2 has a user
  assert.match(proxyListHtml({ proxies: [] }), /No saved proxies/);
  assert.equal(proxyName({ label: " ", host: "h.example.org" }), "h.example.org");
});

test("list actions: use, stop, rename, delete (active stops it), cancel keeps it", async () => {
  const sh = shell({ proxies: [P1, P2], active: "p1" });
  let reopened = [];
  const deps = { ...ui(), invoke: sh.invoke, reopen: id => { reopened.push(id); }, close() {}, askText: async () => "Work" };
  await proxyAction("use", { ...P2 }, deps);
  assert.equal(sh.active, "p2");
  await proxyAction("off", { ...P2, active: true }, deps);
  assert.equal(sh.active, null);
  await proxyAction("rename", P2, deps);
  assert.equal(sh.proxies.find(x => x.id === "p2").label, "Work");
  // Cancelled delete changes nothing.
  await proxyAction("delete", P1, { ...deps, confirmModal: async () => false });
  assert.equal(sh.proxies.length, 2);
  await proxyAction("use", P1, deps);
  let text = "";
  await proxyAction("delete", { ...P1, active: true }, { ...deps, confirmModal: async (title, body, ok, danger) => { text = body; assert.equal(ok, "Delete"); assert.equal(danger, true); return true; } });
  assert.match(text, /is in use\. Deleting it stops using the proxy/);
  assert.deepEqual(sh.proxies.map(x => x.id), ["p2"]);
  assert.equal(sh.active, null);
  // The sheet reopens on the row acted on (focus returns there).
  assert.deepEqual(reopened.slice(0, 4), ["p2", "p2", "p2", "p1"]);
});

test("share uses the chosen proxy's id", async () => {
  const els = {};
  const mkEl = () => ({ addEventListener() {}, textContent: "", innerHTML: "", isConnected: true });
  globalThis.document = { createElement: () => ({ set innerHTML(v) { this.html = v; }, get innerHTML() { return this.html; }, querySelector: sel => (els[sel] ||= mkEl()) }) };
  const sh = shell({ proxies: [P1] });
  const r = await openProxyShare({ showModal: () => ({ close() {} }), toast() {}, errToast: e => assert.fail(e), id: "p1", invoke: sh.invoke });
  assert.deepEqual(sh.calls.find(c => c[0] === "proxy_link")[1], { id: "p1" });
  assert.match(r.link, /\/N\/J5TGM2LDMU$/); // base32("Office")
  delete globalThis.document;
});

test("status: saved proxies but none in use; not set up; in use", async () => {
  assert.equal(describeProxy({ installed: true, active: null, count: 2 }).headline, "Off");
  assert.equal(describeProxy({ installed: false }).headline, "Not set up");
  const d = describeProxy({ installed: true, active: "p1", active_label: "Home" });
  assert.equal(d.headline, "In use");
  assert.equal(d.detail, "Mail goes through Home.");
  const sh = shell({ proxies: [P1], active: null });
  const s = await refreshProxyStatus(sh.invoke);
  assert.equal(s.installed, true);
  assert.equal(s.active, null);
});
