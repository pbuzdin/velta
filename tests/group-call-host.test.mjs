// GroupCallSession (app/js/group-call-host.js) over a fake core shared by
// several clients: status updates reach every client, realtime only the
// clients that advertised. Also the webxdc-manager routing rules.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FakePC, mkStream } from "./helpers/fake-webrtc.mjs";
import { GroupCallSession, joinGroupCall, leaveGroupCall, currentGroupCall, routeRealtime, _resetForTests, iceServersFrom } from "../app/js/group-call-host.js";
import { encodeRealtime } from "../app/js/group-call-signal.js";
import { FALLBACK_ICE_SERVERS } from "../app/js/calls.js";

function chat() {
  const rows = []; const clients = [];
  const mkCore = (opts = {}) => {
    const c = {
      joined: new Set(), sentRt: 0, left: [],
      iceServers: async () => [{ urls: "turn:x" }],
      getWebxdcStatusUpdates: async (_m, since) => JSON.stringify(rows.filter((r) => r.serial > since)),
      sendWebxdcStatusUpdate: async (msgId, json) => {
        const u = JSON.parse(json); const row = { ...u, serial: rows.length + 1 }; rows.push(row);
        setTimeout(() => { for (const x of clients) x.session?.onStatusUpdate(row.serial); }, 1);
      },
      sendWebxdcRealtimeAdvertisement: async (msgId) => { if (opts.noRt) throw new Error("no realtime"); c.joined.add(msgId); },
      sendWebxdcRealtimeData: async (msgId, arr) => { c.sentRt++; setTimeout(() => { for (const x of clients) if (x.core !== c && x.core.joined.has(msgId)) x.session?.onRealtime(arr); }, 1); },
      leaveWebxdcRealtime: async (m) => { c.left.push(m); c.joined.delete(m); },
    };
    return c;
  };
  const add = (id, o = {}) => {
    const core = mkCore(o); const x = { core };
    x.session = new GroupCallSession({ core, msgId: 7, chatId: 3, selfId: id, selfName: id, realtime: !o.noRtCap,
      env: { RTCPeerConnection: FakePC, getUserMedia: async () => mkStream(), releaseRealtime: (m) => core.leaveWebxdcRealtime(m), document: null } });
    x.session.call.gatherTimeout = 5; x.session.call.offerRetryMs = 30;
    clients.push(x); return x;
  };
  return { add, rows };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms = 2000) { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(10); } return false; }

test("three hosts (one without realtime, like the PWA) connect over the shared chat", async () => {
  const c = chat();
  const a = c.add("a"), b = c.add("b"), p = c.add("p", { noRtCap: true });
  await a.session.start(); await b.session.start(); await p.session.start();
  const ok = await until(() => [a, b, p].every((x) => [...x.session.call.peers.values()].filter((q) => q.state === "connected").length === 2));
  assert.ok(ok, "full mesh");
  const offers = c.rows.filter((r) => r.payload?.veltaCall?.t === "offer");
  assert.ok(offers.every((r) => [r.payload.veltaCall.from, r.payload.veltaCall.to].includes("p") || r.payload.veltaCall.try >= 2), "status-update SDP only for the PWA pair (or retries)");
  assert.ok(a.core.sentRt > 0, "a<->b used realtime");
  assert.equal(c.rows.filter((r) => r.info).length, 1);
  for (const x of [a, b, p]) { await x.session.leave(); await wait(30); }
  assert.equal(c.rows.at(-1).info, "Group call ended");
  assert.deepEqual(a.core.left, [7], "host leaves the realtime channel it joined");
});

test("realtime join failure falls back to status updates", async () => {
  const c = chat();
  const a = c.add("a", { noRt: true }), b = c.add("b");
  await a.session.start(); await b.session.start();
  assert.equal(a.session.realtime, false);
  assert.ok(await until(() => a.session.call.peers.get("b")?.state === "connected"));
  await a.session.leave(); await b.session.leave();
});

test("one call at a time; join while busy is refused", async () => {
  _resetForTests();
  const core = chat().add("x").core;
  const env = { RTCPeerConnection: FakePC, getUserMedia: async () => mkStream(), document: null };
  await assert.rejects(joinGroupCall({ core, msgId: 1, selfId: "x", env, busy: () => true }), /current call/);
  const s = await joinGroupCall({ core, msgId: 1, selfId: "x", env });
  assert.equal(currentGroupCall(), s);
  assert.equal(await joinGroupCall({ core, msgId: 1, selfId: "x", env }), s);
  await assert.rejects(joinGroupCall({ core, msgId: 2, selfId: "x", env }), /already/);
  await leaveGroupCall();
  assert.equal(currentGroupCall(), null);
});

test("mic denied: no call is left behind", async () => {
  _resetForTests();
  const core = chat().add("x").core;
  await assert.rejects(joinGroupCall({ core, msgId: 1, selfId: "x", env: { RTCPeerConnection: FakePC, getUserMedia: async () => { throw new Error("NotAllowed"); }, document: null } }));
  assert.equal(currentGroupCall(), null);
});

test("routing: call frames never reach an app, app frames pass", () => {
  _resetForTests();
  assert.equal(routeRealtime(9, Array.from(encodeRealtime({ vgc: 1, t: "hb", from: "a", sid: "s" }))), true);
  assert.equal(routeRealtime(9, Array.from(new TextEncoder().encode("app data"))), false);
  const m = readFileSync(new URL("../app/js/webxdc-manager.js", import.meta.url), "utf8");
  assert.match(m, /if \(routeRealtime\(d\.msgId, d\.data\)\) return;\s*if \(!active\?\.realtime/);
  assert.match(m, /currentGroupCall\(\)\?\.msgId !== active\.msgId\) core\?\.leaveWebxdcRealtime/);
  assert.match(m, /currentGroupCall\(\)\?\.msgId !== msgId\) await core\.leaveWebxdcRealtime/);
});

test("ICE servers: core list, else the turn.delta.chat fallback", async () => {
  assert.deepEqual(await iceServersFrom({ iceServers: async () => [{ urls: "turn:a" }] }), [{ urls: "turn:a" }]);
  assert.deepEqual(await iceServersFrom({ iceServers: async () => [] }), FALLBACK_ICE_SERVERS);
});
