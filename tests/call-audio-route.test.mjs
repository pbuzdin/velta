import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CallManager, MIC_CONSTRAINTS, callButtonsHtml, defaultSpeakerOn, sdpAudioDirection, shellAudioRoute,
} from "../app/js/calls.js";

// #141: "the microphone doesn't work" (the mic was opened but its track was
// never added to the RTCPeerConnection, so every offer/answer was recvonly),
// earpiece by default on Android, and a loudspeaker toggle.

// Records the order of the WebRTC calls that matter for the SDP direction.
class OrderPC {
  constructor(log) {
    this.log = log;
    this.iceGatheringState = "complete";
    this.localDescription = null;
    this.added = [];
  }
  addEventListener() {}
  removeEventListener() {}
  addTrack(track, stream) {
    this.log.push("addTrack");
    this.added.push({ track, stream });
    return { track };
  }
  getSenders() { return this.added.map(({ track }) => ({ track })); }
  // A real offer/answer is sendrecv only when a track was added first.
  _sdp(type) {
    const dir = this.added.length ? "sendrecv" : "recvonly";
    return `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=${dir}\r\n`;
  }
  async createOffer() { this.log.push("createOffer"); return { type: "offer", sdp: this._sdp("offer") }; }
  async createAnswer() { this.log.push("createAnswer"); return { type: "answer", sdp: this._sdp("answer") }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.log.push(`setRemote:${d.type}`); }
  close() {}
}

function makeRoute(supported = true) {
  const calls = [];
  return {
    calls,
    supported,
    start: async (speaker) => { calls.push(["start", speaker]); return speaker ? "speaker" : "earpiece"; },
    setSpeaker: async (on) => { calls.push(["speaker", on]); return on ? "speaker" : "earpiece"; },
    stop: async () => { calls.push(["stop"]); },
  };
}

function setup(t, { route = makeRoute(), gum } = {}) {
  const order = [];
  const listeners = new Map();
  const core = {
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    placed: [],
    accepted: [],
    async placeOutgoingCall(chatId, sdp) { this.placed.push(sdp); return 77; },
    async acceptIncomingCall(msgId, sdp) { this.accepted.push(sdp); },
    async endCall() {},
    async callInfo() { return { sdpOffer: "v=0\r\nm=audio 9 X 111\r\na=sendrecv\r\n", hasVideo: false }; },
    async iceServers() { return []; },
    async getChat() { return { name: "Bob" }; },
  };
  const emit = (name, detail) => { for (const fn of listeners.get(name) || []) fn({ detail }); };
  const track = { kind: "audio", enabled: true, stopped: false, stop() { this.stopped = true; order.push("track.stop"); } };
  const gumCalls = [];
  const getUserMedia = gum || (async (c) => {
    gumCalls.push(c);
    return { getAudioTracks: () => [track], getTracks: () => [track] };
  });
  const logs = [];
  const r = route;
  const origStop = r.stop;
  r.stop = async () => { order.push("route.stop"); return origStop(); };
  const mgr = new CallManager(core, () => new OrderPC(order), getUserMedia, () => {}, r, (m) => logs.push(m));
  mgr.endedVisibleMs = 1;
  mgr.bind();
  t.after(() => mgr.teardown(true));
  return { mgr, core, emit, order, track, gumCalls, route: r, logs };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

test("outgoing: the mic track is added BEFORE createOffer, so the offer sends audio", async (t) => {
  const { mgr, core, order, track, gumCalls } = setup(t);
  assert.equal(await mgr.startOutgoing(1, "Bob"), true);
  assert.deepEqual(gumCalls, [MIC_CONSTRAINTS]);
  assert.ok(order.indexOf("addTrack") >= 0, "addTrack was called");
  assert.ok(order.indexOf("addTrack") < order.indexOf("createOffer"));
  assert.equal(mgr.pc.added[0].track, track);
  assert.equal(sdpAudioDirection(core.placed[0]), "sendrecv");
});

test("incoming: addTrack after the remote offer and before createAnswer (answer is sendrecv)", async (t) => {
  const { mgr, core, emit, order } = setup(t);
  emit("incoming-call", { msgId: 9, chatId: 2 });
  await settle();
  await mgr.acceptIncoming();
  assert.equal(mgr.state, "active");
  const iRemote = order.indexOf("setRemote:offer");
  const iAdd = order.indexOf("addTrack");
  const iAnswer = order.indexOf("createAnswer");
  assert.ok(iRemote >= 0 && iRemote < iAdd && iAdd < iAnswer, order.join(","));
  assert.equal(sdpAudioDirection(core.accepted[0]), "sendrecv");
});

test("a muted call keeps its sender: mute flips track.enabled only", async (t) => {
  const { mgr, emit, track } = setup(t);
  emit("incoming-call", { msgId: 9, chatId: 2 });
  await settle();
  await mgr.acceptIncoming();
  assert.equal(mgr.toggleMute(), true);
  assert.equal(track.enabled, false);
  assert.equal(mgr.pc.getSenders()[0].track, track);
});

test("getUserMedia without an audio track fails the call instead of sending silence", async (t) => {
  const { mgr } = setup(t, { gum: async () => ({ getAudioTracks: () => [], getTracks: () => [] }) });
  assert.equal(await mgr.startOutgoing(1, "Bob"), false);
  assert.equal(mgr.state, "ended");
});

test("Android: the route starts on the earpiece after getUserMedia, toggles, and stops after the tracks", async (t) => {
  const { mgr, emit, route, order } = setup(t);
  await mgr.startOutgoing(1, "Bob");
  await settle();
  assert.deepEqual(route.calls[0], ["start", false]);
  assert.equal(mgr.route, "earpiece");
  assert.deepEqual(mgr.controls(), ["speaker", "hangup"]); // ringing: speaker, no mute yet
  emit("outgoing-call-accepted", { msgId: 77, acceptCallInfo: "v=0\r\nm=audio 9 X 111\r\na=sendrecv\r\n" });
  await settle();
  assert.deepEqual(mgr.controls(), ["mute", "speaker", "hangup"]);
  assert.equal(await mgr.toggleSpeaker(), true);
  assert.deepEqual(route.calls.at(-1), ["speaker", true]);
  assert.equal(mgr.route, "speaker");
  assert.equal(await mgr.toggleSpeaker(), false);
  assert.deepEqual(route.calls.at(-1), ["speaker", false]);
  mgr.hangUp();
  await settle();
  assert.deepEqual(route.calls.at(-1), ["stop"]);
  assert.ok(order.indexOf("track.stop") < order.indexOf("route.stop"), order.join(","));
  assert.equal(mgr.state, "idle");
});

test("the route stops when the remote side ends the call", async (t) => {
  const { mgr, emit, route } = setup(t);
  await mgr.startOutgoing(1, "Bob");
  emit("call-ended", { msgId: 77 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mgr.state, "idle");
  assert.deepEqual(route.calls.at(-1), ["stop"]);
});

test("no route on desktop / PWA: no speaker button, no shell calls", async (t) => {
  const route = makeRoute(false);
  const { mgr, emit } = setup(t, { route });
  await mgr.startOutgoing(1, "Bob");
  emit("outgoing-call-accepted", { msgId: 77, acceptCallInfo: "v=0\r\n" });
  await settle();
  assert.deepEqual(mgr.controls(), ["mute", "hangup"]);
  assert.equal(await mgr.toggleSpeaker(), false);
  mgr.hangUp();
  await settle();
  assert.deepEqual(route.calls, []);
});

test("a failing shell route does not break the call", async (t) => {
  const route = makeRoute();
  route.start = async () => { throw new Error("no shell"); };
  const { mgr, emit } = setup(t, { route });
  await mgr.startOutgoing(1, "Bob");
  emit("outgoing-call-accepted", { msgId: 77, acceptCallInfo: "v=0\r\n" });
  await settle();
  assert.equal(mgr.state, "active");
});

test("shellAudioRoute is unsupported outside the Android shell (node, PWA)", () => {
  assert.equal(shellAudioRoute().supported, false);
});

test("default route: earpiece for audio calls, loudspeaker for video", () => {
  assert.equal(defaultSpeakerOn(false), false);
  assert.equal(defaultSpeakerOn(true), true);
});

test("speaker button: a toggle with a fixed label, aria-pressed and an icon", () => {
  const off = callButtonsHtml(["mute", "speaker", "hangup"], { speaker: false });
  assert.match(off, /data-call="speaker"[^>]*aria-pressed="false"/);
  assert.match(off, /<span>Speaker<\/span>/);
  assert.match(off, /<svg class="call-btn-ico"[^>]*aria-hidden="true"/);
  assert.match(off, /type="button"/);
  const on = callButtonsHtml(["speaker"], { speaker: true });
  assert.match(on, /aria-pressed="true"/);
  assert.match(on, /class="call-btn call-speaker on"/);
  assert.equal(callButtonsHtml(["hangup"]).includes("speaker"), false);
});

test("sdpAudioDirection reads the audio m-line only", () => {
  const sdp = "v=0\r\nm=video 9 X 96\r\na=recvonly\r\nm=audio 9 X 111\r\na=sendrecv\r\n";
  assert.equal(sdpAudioDirection(sdp), "sendrecv");
  assert.equal(sdpAudioDirection("v=0\r\nm=audio 9 X 111\r\na=recvonly\r\n"), "recvonly");
  assert.equal(sdpAudioDirection("v=0\r\nm=audio 9 X 111\r\n"), "sendrecv");
  assert.equal(sdpAudioDirection("v=0\r\n"), "none");
});

test("shell wiring: lib.rs registers the call_audio_* commands and caches CallAudio", () => {
  const lib = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const cmd of ["call_audio_start", "call_audio_speaker", "call_audio_stop"]) {
    assert.match(lib, new RegExp(`generate_handler!\\[[^\\]]*\\b${cmd}\\b`), `${cmd} registered`);
  }
  assert.match(lib, /\("CallAudio", &APP_CALL_AUDIO_CLASS\)/);
  const kt = readFileSync(new URL("../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/CallAudio.kt", import.meta.url), "utf8");
  assert.match(kt, /fun start\(context: Context, speakerOn: Boolean\): String/);
  assert.match(kt, /fun setSpeaker\(context: Context, on: Boolean\): String/);
  assert.match(kt, /fun stop\(context: Context\)/);
  assert.match(kt, /MODE_IN_COMMUNICATION/);
  assert.match(kt, /TYPE_BUILTIN_EARPIECE/);
  assert.match(kt, /MODE_NORMAL/);
  const manifest = readFileSync(new URL("../velta-app/src-tauri/gen/android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/);
  assert.match(manifest, /android\.permission\.MODIFY_AUDIO_SETTINGS/);
});
