import test from "node:test";
import assert from "node:assert/strict";
import { CallManager } from "../app/js/calls.js";

// Headless exercise of the call state machine: the WebRTC/DOM adapter is
// replaced by fakes, so what's under test is the signaling flow (which core
// methods fire with which payloads) and the state transitions.

class FakePC {
  constructor(cfg) {
    this.cfg = cfg;
    this.iceGatheringState = "complete";
    this.localDescription = { type: "offer", sdp: "local-sdp" };
    this._remote = null;
    this.listeners = new Map();
  }
  addEventListener() {}
  removeEventListener() {}
  async createOffer() { return { type: "offer", sdp: "offer-sdp" }; }
  async createAnswer() { return { type: "answer", sdp: "answer-sdp" }; }
  async setLocalDescription(d) { this.appliedLocal = d; this.localDescription = d; }
  async setRemoteDescription(d) { this._remote = d; this.appliedRemote = d; }
  close() { this.closed = true; }
}

const makeManager = (t) => {
  const listeners = new Map();
  const core = new EventTarget();
  core.addEventListener = (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(fn);
  };
  const emit = (name, detail) => {
    for (const fn of listeners.get(name) || []) fn({ detail });
  };
  const calls = { placed: [], accepted: [], ended: [] };
  core.placeOutgoingCall = async (chatId, info, hasVideo) => {
    calls.placed.push({ chatId, info, hasVideo });
    return 4321;
  };
  core.acceptIncomingCall = async (msgId, info) => { calls.accepted.push({ msgId, info }); };
  core.endCall = async (msgId) => { calls.ended.push(msgId); };
  core.callInfo = async () => ({ sdpOffer: "remote-offer-sdp", hasVideo: false, state: "Ringing" });
  core.iceServers = async () => [{ urls: ["stun:relay.example:3478"] }];
  core.getChat = async () => ({ name: "Alice" });

  const tracks = [{ enabled: true }];
  const mgr = new CallManager(core, (cfg) => new FakePC(cfg), async () => ({
    getAudioTracks: () => tracks,
  }), (msg) => { mgr.notes = mgr.notes || []; mgr.notes.push(msg); });
  mgr.endedVisibleMs = 5;
  mgr.bind();
  t.after(() => mgr.teardown(true)); // also stops the duration interval
  const flush = () => new Promise((r) => setImmediate(r));
  return { mgr, emit, calls, flush, listeners };
};

test("outgoing call: offer placed through the core, answer connects, end hangs up", async (t) => {
  const { mgr, emit, calls, flush } = makeManager(t);
  const started = await mgr.startOutgoing(7, "Alice");
  assert.equal(started, true);
  assert.equal(mgr.state, "outgoing");
  assert.deepEqual(calls.placed, [{ chatId: 7, info: "offer-sdp", hasVideo: false }]);

  emit("outgoing-call-accepted", { msgId: 4321, chatId: 7, acceptCallInfo: "answer-sdp" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(mgr.state, "active");
  assert.equal(mgr.pc.appliedRemote.sdp, "answer-sdp");

  emit("call-ended", { msgId: 4321, chatId: 7 });
  assert.equal(mgr.state, "ended");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mgr.state, "idle");
});

test("incoming call: accept fetches the offer, sends the SDP answer", async (t) => {
  const { mgr, emit, calls, flush } = makeManager(t);
  emit("incoming-call", { msgId: 55, chatId: 3, placeCallInfo: "remote-offer-sdp", hasVideo: false });
  await flush();
  assert.equal(mgr.state, "incoming");
  assert.equal(mgr.chatName, "Alice");

  await mgr.acceptIncoming();
  assert.equal(mgr.state, "active");
  assert.deepEqual(calls.accepted, [{ msgId: 55, info: "answer-sdp" }]);
  assert.equal(mgr.pc.appliedRemote.sdp, "remote-offer-sdp");

  emit("call-ended", { msgId: 55, chatId: 3 });
  assert.equal(mgr.state, "ended");
});

test("decline ends the call through the core without an answer", async (t) => {
  const { mgr, emit, calls, flush } = makeManager(t);
  emit("incoming-call", { msgId: 56, chatId: 3, placeCallInfo: "x", hasVideo: false });
  await flush();
  mgr.declineIncoming();
  assert.deepEqual(calls.ended, [56]);
  assert.equal(mgr.state, "idle");
});

test("acceptance on another device stands an incoming ring down", async (t) => {
  const { mgr, emit, calls, flush } = makeManager(t);
  emit("incoming-call", { msgId: 57, chatId: 3, placeCallInfo: "x", hasVideo: false });
  await flush();
  emit("incoming-call-accepted", { msgId: 57, chatId: 3, fromThisDevice: false });
  await flush();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(mgr.state, "idle");
  assert.deepEqual(calls.ended, []);
});

test("mute toggles the local track", async (t) => {
  const { mgr, flush } = makeManager(t);
  await mgr.startOutgoing(7, "Alice");
  const track = mgr.localStream.getAudioTracks()[0];
  assert.equal(track.enabled, true);
  assert.equal(mgr.toggleMute(), true);
  assert.equal(track.enabled, false);
  assert.equal(mgr.toggleMute(), false);
  assert.equal(track.enabled, true);
});

test("a call-ended for another msgId does not touch the active call", async (t) => {
  const { mgr, emit, flush } = makeManager(t);
  await mgr.startOutgoing(7, "Alice");
  emit("outgoing-call-accepted", { msgId: 4321, chatId: 7, acceptCallInfo: "answer-sdp" });
  await Promise.resolve(); await Promise.resolve();
  emit("call-ended", { msgId: 999, chatId: 7 });
  assert.equal(mgr.state, "active");
});
