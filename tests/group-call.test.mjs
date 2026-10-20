// GroupCall (app/js/group-call.js): mesh state machine with a fake WebRTC.
// Real WebRTC between several Chromium pages: scripts/e2e-group-call.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { GroupCall, GROUP_CALL_MAX, admitted, isOfferer, tuneOpus } from "../app/js/group-call.js";

import { FakePC, pcs, mkStream } from "./helpers/fake-webrtc.mjs";

function network(ids, opts = {}) {
  pcs.length = 0;
  const calls = new Map();
  const sent = [];
  const at = Object.fromEntries(ids.map((id, i) => [id, 1000 + i]));
  for (const id of ids) {
    const c = new GroupCall({
      selfId: id, selfName: id.toUpperCase(), RTCPeerConnection: FakePC,
      getUserMedia: async () => mkStream(), iceServers: async () => [{ urls: "turn:t" }],
      send: async (m) => { sent.push(m); if (opts.drop?.(m)) return; queueMicrotask(() => calls.get(m.to)?.handleSignal(m)); },
      setInterval: () => 0, clearInterval: () => {}, gatherTimeout: 10, offerRetryMs: 20, ...opts.extra,
    });
    calls.set(id, c);
  }
  const roster = () => ids.map((id) => ({ id, name: id.toUpperCase(), sid: calls.get(id).sid, at: at[id] }));
  return { calls, sent, roster };
}
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test("pure helpers", () => {
  assert.equal(isOfferer("a@x", "b@x"), true);
  assert.equal(isOfferer("b@x", "a@x"), false);
  const r = Array.from({ length: 8 }, (_, i) => ({ id: `u${i}`, at: 100 - i }));
  assert.deepEqual(admitted(r).map((m) => m.id), ["u7", "u6", "u5", "u4", "u3", "u2"]);
  assert.equal(GROUP_CALL_MAX, 6);
  const t = tuneOpus("m=audio\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=0\r\n");
  assert.match(t, /a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=32000;usedtx=1;stereo=0/);
  assert.match(tuneOpus("a=rtpmap:109 opus/48000/2\r\n"), /a=fmtp:109 maxaveragebitrate=32000/);
});

test("three participants form a full mesh, relay-only, one offer per pair", async () => {
  const { calls, sent, roster } = network(["a", "b", "c"]);
  for (const c of calls.values()) await c.join();
  for (const c of calls.values()) c.setRoster(roster());
  await settle();
  for (const [id, c] of calls) {
    const s = c.snapshot();
    assert.equal(s.state, "active", id);
    assert.equal(s.participants.length, 3, id);
    assert.ok(s.participants.filter((p) => !p.self).every((p) => p.state === "connected"), `${id} connected to all`);
  }
  assert.equal(sent.filter((m) => m.t === "offer").length, 3);
  assert.equal(sent.filter((m) => m.t === "answer").length, 3);
  assert.ok(sent.filter((m) => m.t === "offer").every((m) => isOfferer(m.from, m.to)));
  assert.ok(pcs.every((p) => p.cfg.iceTransportPolicy === "relay" && p.cfg.iceServers[0].urls === "turn:t"));
  assert.ok(pcs.every((p) => p.dcOpts.negotiated && p.dcOpts.id === 3));
});

test("mute flips track.enabled and reaches peers over the state channel", async () => {
  const { calls, roster } = network(["a", "b"]);
  for (const c of calls.values()) await c.join();
  for (const c of calls.values()) c.setRoster(roster());
  await settle();
  calls.get("a").setMuted(true);
  assert.equal(calls.get("a").stream.t.enabled, false);
  const seen = calls.get("b").snapshot().participants.find((p) => p.id === "a");
  assert.equal(seen.muted, true);
  assert.equal(seen.speaking, false);
});

test("unanswered offer is retried; duplicate offer gets the same answer", async () => {
  let dropped = 0;
  const { calls, sent, roster } = network(["a", "b"], { drop: (m) => m.t === "offer" && dropped++ < 1 });
  for (const c of calls.values()) await c.join();
  for (const c of calls.values()) c.setRoster(roster());
  await settle(120);
  assert.ok(sent.filter((m) => m.t === "offer").length >= 2, "offer resent");
  assert.equal(calls.get("a").peers.get("b").state, "connected");
  const ans = sent.filter((m) => m.t === "answer");
  const offer = sent.find((m) => m.t === "offer");
  await calls.get("b").handleSignal(offer); // duplicate via the other transport
  await settle(10);
  assert.equal(sent.filter((m) => m.t === "answer").length, ans.length + 1);
  assert.equal(sent.at(-1).sdp, ans[0].sdp);
});

test("the 7th joiner gets 'full' and opens no connection", async () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const { calls, roster } = network(ids);
  for (const c of calls.values()) await c.join();
  for (const c of calls.values()) c.setRoster(roster());
  await settle();
  assert.equal(calls.get("g").snapshot().state, "full");
  assert.equal(calls.get("g").peers.size, 0);
  assert.equal(calls.get("a").snapshot().participants.length, 6);
  assert.equal(calls.get("a").snapshot().waiting, 1);
  // someone leaves -> g gets in
  calls.get("c").leave();
  const r = roster().filter((m) => m.id !== "c");
  for (const c of calls.values()) if (c.state !== "ended") c.setRoster(r);
  await settle();
  assert.equal(calls.get("g").snapshot().state, "active");
  assert.equal(calls.get("g").peers.size, 5);
});

test("leave stops the mic and closes peers; leaving roster drops the peer", async () => {
  const detached = [];
  const { calls, roster } = network(["a", "b", "c"], { extra: { detachAudio: (id) => detached.push(id) } });
  for (const c of calls.values()) await c.join();
  for (const c of calls.values()) c.setRoster(roster());
  await settle();
  const a = calls.get("a"); const t = a.stream.t;
  calls.get("b").setRoster(roster().filter((m) => m.id !== "a"));
  assert.equal(calls.get("b").peers.has("a"), false);
  a.leave();
  assert.equal(t.stopped, true);
  assert.equal(a.peers.size, 0);
  assert.equal(a.snapshot().state, "ended");
  assert.ok(detached.includes("a") && detached.includes("b"));
});

test("a rejoin with a new session replaces the old connection", async () => {
  const { calls, roster } = network(["a", "b"]);
  for (const c of calls.values()) await c.join();
  for (const c of calls.values()) c.setRoster(roster());
  await settle();
  const old = calls.get("a").peers.get("b").pc;
  const r = roster().map((m) => m.id === "b" ? { ...m, sid: "new" } : m);
  calls.get("a").setRoster(r);
  assert.equal(old.closed, true);
  assert.ok(calls.get("a").peers.get("b").pc !== old);
});

test("mic failure ends the call with an error; no peer is created", async () => {
  const c = new GroupCall({ selfId: "a", RTCPeerConnection: FakePC, send() {}, getUserMedia: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); }, setInterval: () => 0 });
  await assert.rejects(c.join());
  assert.equal(c.snapshot().state, "ended");
  assert.match(c.snapshot().error, /microphone/);
});

test("relayOnly:false allows direct candidates (opt-in setting)", async () => {
  pcs.length = 0;
  const c = new GroupCall({ selfId: "a", relayOnly: false, RTCPeerConnection: FakePC, send() {}, getUserMedia: async () => mkStream(), setInterval: () => 0, gatherTimeout: 1 });
  await c.join();
  c.setRoster([{ id: "a", at: 1 }, { id: "b", at: 2 }]);
  assert.equal(pcs[0].cfg.iceTransportPolicy, "all");
  c.leave();
});
