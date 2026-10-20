// GroupCallSignal (app/js/group-call-signal.js): roster + transport choice,
// and GroupCall + GroupCallSignal together over a simulated chat where
// status updates reach everyone and realtime only reaches realtime members.
import test from "node:test";
import assert from "node:assert/strict";
import { GroupCallSignal, encodeRealtime, decodeRealtime, fromStatusUpdate, summaryText, TTL_RT_MS, TTL_UPDATE_MS } from "../app/js/group-call-signal.js";

function room() {
  const nodes = new Map(); let serial = 0; const updates = []; const rtLog = [];
  let clock = 1_000_000;
  const add = (id, { rt = true } = {}) => {
    const s = new GroupCallSignal({
      selfId: id, selfName: id.toUpperCase(), sid: `${id}-s1`, realtime: rt, now: () => clock,
      setInterval: () => 0, clearInterval: () => {},
      sendUpdate: async (u) => { const row = { ...u, serial: ++serial }; updates.push(row); for (const n of nodes.values()) n.ingestUpdates([row]); },
      sendRealtime: async (b) => { rtLog.push(decodeRealtime(b)); for (const n of nodes.values()) if (n !== s && n.rt) n.ingestRealtime(b); },
    });
    s.signals = []; s.onSignal = (m) => s.signals.push(m);
    nodes.set(id, s); return s;
  };
  return { add, nodes, updates, rtLog, tick: (ms) => { clock += ms; } };
}

test("realtime framing and status-update parsing", () => {
  const m = { vgc: 1, t: "join", from: "a", sid: "x" };
  assert.deepEqual(decodeRealtime(encodeRealtime(m)), m);
  assert.equal(decodeRealtime(new TextEncoder().encode("hello app")), null);
  assert.equal(decodeRealtime(encodeRealtime({ vgc: 1, t: "evil", from: "a" })), null);
  assert.deepEqual(fromStatusUpdate({ payload: { veltaCall: m } }), m);
  assert.equal(fromStatusUpdate({ payload: { other: 1 } }), null);
  assert.equal(summaryText(3), "Group call · 3 in call");
});

test("join/leave build the same roster everywhere; info line only for start and end", async () => {
  const r = room();
  const a = r.add("a"), b = r.add("b"), c = r.add("c", { rt: false });
  await a.join(); r.tick(10); await b.join(); r.tick(10); await c.join();
  for (const n of [a, b, c]) assert.deepEqual(n.roster().map((m) => m.id), ["a", "b", "c"]);
  assert.equal(r.updates.filter((u) => u.info).length, 1);
  assert.match(r.updates[0].info, /A started a group call/);
  assert.equal(r.updates.at(-1).summary, "Group call · 3 in call");
  await b.leave(); await a.leave(); await c.leave();
  assert.equal(r.updates.at(-1).info, "Group call ended");
  assert.equal(r.updates.at(-1).summary, "Group call ended");
});

test("SDP: realtime between realtime peers, status update for a PWA peer and for retries; answer follows the offer's transport", async () => {
  const r = room();
  const a = r.add("a"), b = r.add("b"), p = r.add("p", { rt: false });
  await a.join(); await b.join(); await p.join();
  const before = r.updates.length;
  await a.sendSignal({ t: "offer", to: "b", sdp: "o1", try: 1 });
  assert.equal(r.updates.length, before, "no status update for a realtime pair");
  assert.equal(b.signals.at(-1).sdp, "o1");
  await a.sendSignal({ t: "offer", to: "p", sdp: "o2", try: 1 });
  assert.equal(r.updates.length, before + 1, "PWA peer: status update");
  assert.equal(p.signals.at(-1).sdp, "o2");
  await a.sendSignal({ t: "offer", to: "b", sdp: "o1", try: 2 });
  assert.equal(r.updates.length, before + 2, "retry also goes over status updates");
  // b got try 2 twice (rt + update); de-dup per transport, both delivered once each
  assert.equal(b.signals.filter((m) => m.try === 2).length, 2);
  // b answers: last offer came via update -> answer goes via update too
  const n = r.updates.length;
  await b.sendSignal({ t: "answer", to: "a", sdp: "ans" });
  assert.equal(r.updates.length, n + 1);
  assert.equal(a.signals.at(-1).sdp, "ans");
  // signals not for me are ignored
  assert.ok(!p.signals.some((m) => m.sdp === "ans"));
});

test("history replay: an old call's members expire; live ones stay", async () => {
  const r = room();
  const a = r.add("a"), b = r.add("b", { rt: false });
  await a.join(); await b.join();
  const hist = [...r.updates];
  // later, a newcomer replays the history
  r.tick(TTL_UPDATE_MS + 1);
  const late = new GroupCallSignal({ selfId: "z", sid: "z1", now: () => 1_000_000 + TTL_UPDATE_MS + 1, sendUpdate: async () => {}, setInterval: () => 0 });
  late.ingestUpdates(hist);
  assert.deepEqual(late.roster().map((m) => m.id), [], "everyone silent for longer than the TTL");
  const live = new GroupCallSignal({ selfId: "z", sid: "z1", now: () => 1_000_000 + 5000, sendUpdate: async () => {}, setInterval: () => 0 });
  live.ingestUpdates(hist);
  assert.deepEqual(live.roster().map((m) => m.id), ["a", "b"]);
  // stale offers in the history are never replayed into a new call
  const sig = []; live.onSignal = (m) => sig.push(m);
  live.ingestUpdates([{ payload: { veltaCall: { vgc: 1, t: "offer", from: "a", sid: "a-s1", to: "z", sdp: "old" } } }]);
  assert.equal(sig.length, 0);
});

test("a realtime member that goes silent drops out; a connected one stays", async () => {
  const r = room();
  const a = r.add("a"), b = r.add("b");
  await a.join(); await b.join();
  r.tick(TTL_RT_MS + 1);
  assert.deepEqual(a.roster().map((m) => m.id), ["a"]);
  a.isConnected = (id) => id === "b";
  assert.deepEqual(a.roster().map((m) => m.id), ["a", "b"]);
});

test("rejoin with a new session replaces the member; late old-session leave is ignored", () => {
  const s = new GroupCallSignal({ selfId: "me", sid: "m1", now: () => 100, sendUpdate: async () => {} });
  s.ingestUpdates([{ payload: { veltaCall: { vgc: 1, t: "join", from: "b", sid: "b1", at: 10, ts: 10 } } }]);
  s.ingestUpdates([{ payload: { veltaCall: { vgc: 1, t: "join", from: "b", sid: "b2", at: 50, ts: 50 } } }]);
  assert.equal(s.roster()[0].sid, "b2");
  s.ingestUpdates([{ payload: { veltaCall: { vgc: 1, t: "leave", from: "b", sid: "b1", ts: 60 } } }]);
  assert.equal(s.roster().length, 1);
});
