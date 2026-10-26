// Saved DNS tunnels (several, one or none active): link flow, list rows,
// list actions, and the upgrade of the single-tunnel label. The shell-side
// list and the tunnel.json -> tunnels.json migration are Rust unit tests
// (velta-app/src-tauri/src/tunnel_store.rs).
import test from "node:test";
import assert from "node:assert/strict";

const { acceptTunnelLink, tunnelListHtml, tunnelAction, migrateLegacyLabel, refreshTunnelStatus, describeTunnel, tunnelName, tunnelUnsupported, openTunnelShare } = await import("../app/js/tunnel.js");

const KEY_URL = Buffer.alloc(32, 9).toString("base64url");
const LINK = `velta://tunnel?v=1&zone=t.example.org&key=${KEY_URL}&n=Office`;

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}

/** Fake shell with a saved list. */
function shell({ tunnels = [], active = null, existing = null } = {}) {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    switch (cmd) {
      case "tunnel_status": {
        const a = tunnels.find(x => x.id === active);
        return { installed: tunnels.length > 0, available: true, count: tunnels.length, active: a ? a.id : null, active_label: a?.label ?? null, zone: a?.zone };
      }
      case "tunnel_preview": return { zone: "t.example.org", resolvers: 12, existing, count: tunnels.length };
      case "tunnel_list": return { active, tunnels: tunnels.map(x => ({ ...x, active: x.id === active })) };
      case "tunnel_select": active = args.id; return null;
      case "tunnel_delete": tunnels = tunnels.filter(x => x.id !== args.id); if (active === args.id) active = null; return null;
      case "tunnel_rename": tunnels = tunnels.map(x => (x.id === args.id ? { ...x, label: args.label } : x)); return null;
      case "tunnel_install": return { id: "t9", existing: false };
      case "tunnel_link": return { zone: "t.example.org", key: Buffer.alloc(32, 9).toString("base64"), resolvers: [], canaries: [], label: "Office" };
      default: return null;
    }
  };
  return { invoke, calls, get active() { return active; }, get tunnels() { return tunnels; } };
}

const T1 = { id: "t1", label: "Home", zone: "a.example.org", added: 1_700_000_000 };
const T2 = { id: "t2", label: "", zone: "b.example.org", added: 1_700_000_100 };
const ui = (over = {}) => ({ toast() {}, errToast: e => assert.fail(String(e)), confirmModal: async () => true, ...over });

test("link flow: Add / Add and use / Cancel", async () => {
  for (const [pick, activate] of [["use", true], ["add", false], [null, undefined]]) {
    const sh = shell({ tunnels: [T1], active: "t1" });
    let asked; let toastMsg = "";
    const ok = await acceptTunnelLink(LINK, { ...ui({ toast: m => { toastMsg = m; } }), choose: async (...a) => { asked = a; return pick; }, invoke: sh.invoke });
    assert.equal(asked[0], "Add DNS tunnel?");
    assert.deepEqual(asked[2].map(a => a.id), ["add", "use"]);
    assert.match(asked[1], /Name: Office/);
    assert.match(asked[1], /tunnel in use \(Home\)/);
    const install = sh.calls.find(c => c[0] === "tunnel_install");
    if (pick === null) {
      assert.equal(ok, false); assert.equal(install, undefined);
    } else {
      assert.equal(ok, true);
      assert.deepEqual(install[1], { link: LINK, label: "Office", activate });
      assert.equal(toastMsg, activate ? "DNS tunnel added and in use" : "DNS tunnel added");
    }
  }
});

test("link flow: a duplicate (same zone+key) is only offered for activation", async () => {
  const sh = shell({ tunnels: [T1, T2], active: "t1", existing: { id: "t2", label: "", active: false } });
  let asked, chose = false;
  const ok = await acceptTunnelLink(LINK, { ...ui({ confirmModal: async (...a) => { asked = a; return true; } }), choose: async () => { chose = true; return "use"; }, invoke: sh.invoke });
  assert.equal(ok, true);
  assert.equal(chose, false, "no Add dialog for a saved tunnel");
  assert.equal(asked[0], "Use saved DNS tunnel?");
  assert.match(asked[1], /already saved as “t\.example\.org”/);
  assert.ok(!sh.calls.some(c => c[0] === "tunnel_install"));
  assert.deepEqual(sh.calls.find(c => c[0] === "tunnel_select")[1], { id: "t2" });
  assert.equal(sh.active, "t2");
});

test("link flow: the duplicate already in use just says so", async () => {
  const sh = shell({ tunnels: [T1], active: "t1", existing: { id: "t1", label: "Home", active: true } });
  let msg = "", asked = false;
  const ok = await acceptTunnelLink(LINK, { ...ui({ toast: m => { msg = m; }, confirmModal: async () => { asked = true; return true; } }), invoke: sh.invoke });
  assert.equal(ok, true); assert.equal(asked, false);
  assert.match(msg, /already saved and in use \(Home\)/);
  assert.ok(!sh.calls.some(c => ["tunnel_install", "tunnel_select"].includes(c[0])));
});

test("list rows: active marker in text, named accessible buttons, escaping", () => {
  const html = tunnelListHtml({ active: "t1", tunnels: [{ ...T1, active: true }, { ...T2, label: "<img src=x>", active: false }] });
  assert.match(html, /data-id="t1" aria-current="true"/);
  assert.match(html, /In use/);
  assert.equal((html.match(/aria-current/g) || []).length, 1);
  assert.match(html, /aria-label="Stop using Home"/);
  assert.match(html, /aria-label="Use &lt;img src=x&gt;"/);
  for (const a of ["Rename Home", "Share Home", "Delete Home"]) assert.match(html, new RegExp(`aria-label="${a}"`));
  assert.ok(!html.includes("<img src=x>"));
  assert.match(tunnelListHtml({ tunnels: [] }), /No saved tunnels/);
  assert.equal(tunnelName({ label: " ", zone: "z.example.org" }), "z.example.org");
});

test("list actions: use, stop, rename, delete (active stops it), cancel keeps it", async () => {
  const sh = shell({ tunnels: [T1, T2], active: "t1" });
  let reopened = [];
  const deps = { ...ui(), invoke: sh.invoke, reopen: id => { reopened.push(id); }, close() {}, askText: async () => "Work" };
  await tunnelAction("use", { ...T2 }, deps);
  assert.equal(sh.active, "t2");
  await tunnelAction("off", { ...T2, active: true }, deps);
  assert.equal(sh.active, null);
  await tunnelAction("rename", T2, deps);
  assert.equal(sh.tunnels.find(x => x.id === "t2").label, "Work");
  // Cancelled delete changes nothing.
  await tunnelAction("delete", T1, { ...deps, confirmModal: async () => false });
  assert.equal(sh.tunnels.length, 2);
  await tunnelAction("use", T1, deps);
  let text = "";
  await tunnelAction("delete", { ...T1, active: true }, { ...deps, confirmModal: async (title, body, ok, danger) => { text = body; assert.equal(ok, "Delete"); assert.equal(danger, true); return true; } });
  assert.match(text, /is in use\. Deleting it stops the tunnel/);
  assert.deepEqual(sh.tunnels.map(x => x.id), ["t2"]);
  assert.equal(sh.active, null);
  // The sheet reopens on the row acted on (focus returns there).
  assert.deepEqual(reopened.slice(0, 4), ["t2", "t2", "t2", "t1"]);
});

test("share uses the chosen tunnel's id and label", async () => {
  const els = {};
  const mkEl = () => ({ addEventListener() {}, textContent: "", innerHTML: "", isConnected: true });
  globalThis.document = { createElement: () => ({ set innerHTML(v) { this.html = v; }, get innerHTML() { return this.html; }, querySelector: sel => (els[sel] ||= mkEl()) }) };
  const sh = shell({ tunnels: [T1] });
  const r = await openTunnelShare({ showModal: () => ({ close() {} }), toast() {}, errToast: e => assert.fail(e), id: "t1", invoke: sh.invoke });
  assert.deepEqual(sh.calls.find(c => c[0] === "tunnel_link")[1], { id: "t1" });
  assert.match(r.link, /&n=Office$/);
  delete globalThis.document;
});

test("upgrade: the old single-tunnel label moves onto the migrated entry once", async () => {
  globalThis.localStorage = memStorage({ "velta-tunnel-label": "Office" });
  const sh = shell({ tunnels: [{ ...T1, label: "" }], active: "t1" });
  const s = await refreshTunnelStatus(0, sh.invoke);
  assert.equal(s.active_label, "Office");
  assert.equal(sh.tunnels[0].label, "Office");
  assert.equal(globalThis.localStorage.getItem("velta-tunnel-label"), null);
  await refreshTunnelStatus(0, sh.invoke);
  assert.equal(sh.calls.filter(c => c[0] === "tunnel_rename").length, 1);
  // An older shell (no list) keeps the label where it was.
  globalThis.localStorage = memStorage({ "velta-tunnel-label": "Office" });
  await migrateLegacyLabel({ installed: true, available: true }, async () => assert.fail("no rename"));
  assert.equal(globalThis.localStorage.getItem("velta-tunnel-label"), "Office");
  delete globalThis.localStorage;
});

test("status: saved tunnels but none in use; unsupported platforms", () => {
  assert.equal(describeTunnel({ installed: true, active: null, count: 2 }).headline, "Off");
  assert.equal(describeTunnel({ installed: true, available: true, route: "direct", state: "ok" }).headline, "Direct");
  assert.equal(tunnelUnsupported({ available: false, installed: false, unsupported: true }), true);
  assert.equal(tunnelUnsupported({ available: false, installed: false, error: "The DNS tunnel is only available in the Android app" }), true);
  assert.equal(tunnelUnsupported({ available: false, installed: false, error: "DNS tunnel library not available: x" }), false);
});
