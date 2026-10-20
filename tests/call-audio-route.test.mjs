import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CallManager, MIC_CONSTRAINTS, callButtonsHtml, defaultSpeakerOn, sdpAudioDirection, sdpDirection,
  sdpHasVideo, shellAudioRoute, cameraConstraints, avatarInitial, CALL_ICONS,
} from "../app/js/calls.js";

// #141: the mic track on a sender before offer/answer, earpiece by default
// on Android, a loudspeaker toggle, video calls (camera mid-call through the
// always-present video transceiver, like Delta Chat), Delta Chat's
// negotiated data channels.

const sdpFor = (audio, video) =>
  `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=${audio}\r\n` +
  (video ? `m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=${video}\r\n` : "");

// Records the order of the WebRTC calls that matter for the SDP direction.
class OrderPC {
  constructor(log, remoteKinds = ["audio", "video"]) {
    this.log = log;
    this.remoteKinds = remoteKinds;
    this.iceGatheringState = "complete";
    this.localDescription = null;
    this.txs = [];
    this.channels = [];
  }
  addEventListener() {}
  removeEventListener() {}
  _tx(kind, track) {
    const log = this.log;
    const tx = {
      kind, direction: "recvonly",
      receiver: { track: { kind } },
      sender: { track, async replaceTrack(t) { log.push(`replaceTrack:${kind}:${t ? "track" : "null"}`); this.track = t; }, setStreams() {} },
    };
    this.txs.push(tx);
    return tx;
  }
  addTransceiver(trackOrKind, init) {
    const kind = typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
    this.log.push(`addTransceiver:${kind}`);
    const tx = this._tx(kind, typeof trackOrKind === "string" ? null : trackOrKind);
    tx.direction = init?.direction || "sendrecv";
    return tx;
  }
  addTrack(track) {
    this.log.push("addTrack");
    const tx = this.txs.find((t) => t.kind === track.kind && !t.sender.track) || this._tx(track.kind, null);
    tx.sender.track = track;
    tx.direction = "sendrecv";
    return tx.sender;
  }
  getTransceivers() { return this.txs; }
  getSenders() { return this.txs.map((t) => t.sender); }
  createDataChannel(label, init) {
    const ch = { label, ...init, readyState: "connecting", sent: [], send(m) { this.sent.push(m); } };
    this.channels.push(ch);
    return ch;
  }
  _sdp() {
    const dir = (k) => {
      const t = this.txs.find((x) => x.kind === k);
      if (!t) return null;
      return t.direction === "sendrecv" && (t.sender.track || k === "video") ? "sendrecv" : "recvonly";
    };
    return sdpFor(dir("audio") || "inactive", dir("video"));
  }
  async createOffer() { this.log.push("createOffer"); return { type: "offer", sdp: this._sdp() }; }
  async createAnswer() { this.log.push("createAnswer"); return { type: "answer", sdp: this._sdp() }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) {
    this.log.push(`setRemote:${d.type}`);
    if (d.type === "offer") for (const k of this.remoteKinds) this._tx(k, null);
  }
  async addIceCandidate(c) { this.log.push(`ice:${c ? "cand" : "end"}`); }
  close() {}
}

function makeRoute(supported = true) {
  const calls = [];
  return {
    calls,
    supported,
    start: async (speaker, auto) => { calls.push(["start", speaker, auto]); return speaker ? "speaker" : "earpiece"; },
    setSpeaker: async (on, auto) => { calls.push(["speaker", on, auto]); return on ? "speaker" : "earpiece"; },
    stop: async () => { calls.push(["stop"]); },
  };
}

function setup(t, { route = makeRoute(), gum, offer = sdpFor("sendrecv", "sendrecv"), remoteKinds, cams = 2, failCamera = false } = {}) {
  const order = [];
  const listeners = new Map();
  const core = {
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    placed: [],
    accepted: [],
    async placeOutgoingCall(chatId, sdp, hasVideo) { this.placed.push({ sdp, hasVideo }); return 77; },
    async acceptIncomingCall(msgId, sdp) { this.accepted.push(sdp); },
    async endCall() {},
    async callInfo() { return { sdpOffer: offer, hasVideo: false }; },
    async iceServers() { return []; },
    async getChat() { return { name: "Bob" }; },
  };
  const emit = (name, detail) => { for (const fn of listeners.get(name) || []) fn({ detail }); };
  const mk = (kind, facing) => ({
    kind, enabled: true, readyState: "live", facing,
    getSettings() { return { facingMode: this.facing, deviceId: `${kind}-${facing}` }; },
    stop() { this.readyState = "ended"; order.push(`${kind}.stop`); },
  });
  const track = mk("audio");
  const gumCalls = [];
  const getUserMedia = gum || (async (c) => {
    gumCalls.push(c);
    if (c.video) {
      if (failCamera) throw new Error("NotAllowedError");
      const v = mk("video", c.video.facingMode?.ideal || "user");
      return { getAudioTracks: () => [], getVideoTracks: () => [v], getTracks: () => [v] };
    }
    const list = [track];
    return { getAudioTracks: () => list.filter((x) => x.kind === "audio"), getVideoTracks: () => list.filter((x) => x.kind === "video"),
      getTracks: () => list, addTrack: (x) => list.push(x), removeTrack: (x) => list.splice(list.indexOf(x), 1) };
  });
  const logs = [];
  const r = route;
  const origStop = r.stop;
  r.stop = async () => { order.push("route.stop"); return origStop(); };
  const notes = [];
  const mgr = new CallManager(core, () => new OrderPC(order, remoteKinds), getUserMedia, (m) => notes.push(m), r, (m) => logs.push(m), {
    enumerateDevices: async () => Array.from({ length: cams }, (_, i) => ({ kind: "videoinput", deviceId: `cam${i}` })),
    peerInfo: async () => ({ name: "Bob", addr: "bob@example.org", color: "#a33", avatarUrl: "" }),
  });
  mgr.endedVisibleMs = 1;
  mgr.bind();
  t.after(() => mgr.teardown(true));
  return { mgr, core, emit, order, track, gumCalls, route: r, logs, notes };
}

const settle = () => new Promise((r) => setTimeout(r, 5));
const openChannels = (mgr) => { for (const c of mgr.pc.channels) { c.readyState = "open"; c.onopen?.(); } };

test("outgoing: mic + video transceivers BEFORE createOffer, so the offer sends audio", async (t) => {
  const { mgr, core, order, track, gumCalls } = setup(t);
  assert.equal(await mgr.startOutgoing(1, "Bob"), true);
  assert.deepEqual(gumCalls, [MIC_CONSTRAINTS]); // audio call: camera stays closed
  assert.ok(order.indexOf("addTransceiver:audio") < order.indexOf("createOffer"));
  assert.ok(order.indexOf("addTransceiver:video") < order.indexOf("createOffer"));
  assert.equal(mgr.pc.txs[0].sender.track, track);
  assert.equal(mgr.videoTx.sender.track, null);
  assert.equal(sdpAudioDirection(core.placed[0].sdp), "sendrecv");
  assert.equal(sdpHasVideo(core.placed[0].sdp), true);
  assert.equal(core.placed[0].hasVideo, false);
});

test("outgoing video call: camera opened, has_video set, loudspeaker by default (auto)", async (t) => {
  const { mgr, core, gumCalls, route } = setup(t);
  await mgr.startOutgoing(1, "Bob", { video: true });
  await settle();
  assert.equal(gumCalls.length, 2);
  assert.equal(gumCalls[1].video.facingMode.ideal, "user");
  assert.equal(mgr.videoOn, true);
  assert.ok(mgr.videoTx.sender.track);
  assert.equal(core.placed[0].hasVideo, true);
  assert.deepEqual(route.calls[0], ["start", true, true]);
});

test("Delta Chat data channels: negotiated ids 1 (iceTrickling) and 3 (mutedState)", async (t) => {
  const { mgr } = setup(t);
  await mgr.startOutgoing(1, "Bob");
  const byLabel = Object.fromEntries(mgr.pc.channels.map((c) => [c.label, c]));
  assert.equal(byLabel.iceTrickling.id, 1);
  assert.equal(byLabel.iceTrickling.negotiated, true);
  assert.equal(byLabel.mutedState.id, 3);
  assert.equal(byLabel.mutedState.negotiated, true);
  openChannels(mgr);
  assert.deepEqual(JSON.parse(byLabel.mutedState.sent.at(-1)), { audioEnabled: true, videoEnabled: false });
  mgr.toggleMute();
  assert.deepEqual(JSON.parse(byLabel.mutedState.sent.at(-1)), { audioEnabled: false, videoEnabled: false });
  // A trickled remote candidate is applied.
  byLabel.iceTrickling.onmessage({ data: JSON.stringify({ candidate: "candidate:1 1 udp 1 1.2.3.4 9 typ host", sdpMid: "0" }) });
  byLabel.iceTrickling.onmessage({ data: "null" });
  await settle();
  assert.ok(mgr.pc.log.includes("ice:cand"));
});

test("remote mutedState videoEnabled:false hides the remote video; invalid messages are ignored", async (t) => {
  const { mgr } = setup(t);
  await mgr.startOutgoing(1, "Bob");
  const ch = mgr.pc.channels.find((c) => c.label === "mutedState");
  ch.onmessage({ data: JSON.stringify({ audioEnabled: true, videoEnabled: false }) });
  assert.deepEqual(mgr.remoteMuted, { audioEnabled: true, videoEnabled: false });
  ch.onmessage({ data: JSON.stringify({ videoEnabled: "yes" }) });
  ch.onmessage({ data: "{oops" });
  assert.deepEqual(mgr.remoteMuted, { audioEnabled: true, videoEnabled: false });
});

test("incoming: tracks after the remote offer and before createAnswer (answer sendrecv, video kept)", async (t) => {
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
  assert.equal(sdpDirection(core.accepted[0], "video"), "sendrecv");
  assert.ok(mgr.videoTx, "video transceiver from the offer");
  assert.deepEqual(mgr.controls(), ["mute", "camera", "hangup", "speaker"]);
});

test("incoming video call: Accept with video opens the camera; plain Accept stays audio-only", async (t) => {
  const { mgr, emit, gumCalls } = setup(t);
  emit("incoming-call", { msgId: 9, chatId: 2, hasVideo: true });
  await settle();
  assert.deepEqual(mgr.controls(), ["decline", "accept", "accept-video"]);
  await mgr.acceptIncoming(true);
  assert.equal(mgr.videoOn, true);
  assert.ok(gumCalls.some((c) => c.video));
  assert.ok(mgr.videoTx.sender.track);

  const b = setup(t);
  b.emit("incoming-call", { msgId: 10, chatId: 2, hasVideo: true });
  await settle();
  await b.mgr.acceptIncoming(false);
  assert.equal(b.mgr.videoOn, false);
  assert.ok(!b.gumCalls.some((c) => c.video));
});

test("an offer without video (audio-only peer): no camera button", async (t) => {
  const { mgr, emit } = setup(t, { offer: sdpFor("sendrecv"), remoteKinds: ["audio"] });
  emit("incoming-call", { msgId: 9, chatId: 2 });
  await settle();
  await mgr.acceptIncoming();
  assert.equal(mgr.videoTx, null);
  assert.equal(mgr.controls().includes("camera"), false);
  assert.equal(await mgr.toggleVideo(), false);
});

test("camera mid-call: replaceTrack on the video sender, mutedState, speaker follows video", async (t) => {
  const { mgr, emit, order, route } = setup(t);
  await mgr.startOutgoing(1, "Bob");
  emit("outgoing-call-accepted", { msgId: 77, acceptCallInfo: sdpFor("sendrecv", "sendrecv") });
  await settle();
  openChannels(mgr);
  const ch = mgr.pc.channels.find((c) => c.label === "mutedState");
  assert.equal(await mgr.toggleVideo(), true);
  assert.ok(order.includes("replaceTrack:video:track"));
  assert.deepEqual(JSON.parse(ch.sent.at(-1)), { audioEnabled: true, videoEnabled: true });
  assert.deepEqual(route.calls.at(-1), ["speaker", true, true]); // auto: a headset keeps it
  assert.deepEqual(mgr.controls(), ["mute", "camera", "hangup", "speaker", "flip"]);
  const cam = mgr.camTrack;
  assert.equal(await mgr.toggleVideo(), false);
  assert.ok(order.includes("replaceTrack:video:null"));
  assert.equal(cam.readyState, "ended"); // camera released while off
  assert.deepEqual(JSON.parse(ch.sent.at(-1)), { audioEnabled: true, videoEnabled: false });
  assert.deepEqual(route.calls.at(-1), ["speaker", false, true]);
  assert.equal(mgr.controls().includes("flip"), false);
});

test("flip camera: front <-> back, the old camera is stopped first", async (t) => {
  const { mgr, emit, order } = setup(t);
  await mgr.startOutgoing(1, "Bob", { video: true });
  emit("outgoing-call-accepted", { msgId: 77, acceptCallInfo: sdpFor("sendrecv", "sendrecv") });
  await settle();
  assert.equal(mgr.facing, "user");
  assert.equal(await mgr.flipCamera(), "environment");
  assert.ok(order.lastIndexOf("video.stop") < order.lastIndexOf("replaceTrack:video:track"));
  assert.equal(await mgr.flipCamera(), "user");
});

test("one camera: no flip button", async (t) => {
  const { mgr, emit } = setup(t, { cams: 1 });
  await mgr.startOutgoing(1, "Bob", { video: true });
  emit("outgoing-call-accepted", { msgId: 77, acceptCallInfo: sdpFor("sendrecv", "sendrecv") });
  await settle();
  assert.equal(mgr.controls().includes("flip"), false);
});

test("a blocked camera keeps the video call going audio-only", async (t) => {
  const { mgr, core, notes } = setup(t, { failCamera: true });
  assert.equal(await mgr.startOutgoing(1, "Bob", { video: true }), true);
  assert.equal(mgr.videoOn, false);
  assert.ok(notes.some((n) => /Camera unavailable/.test(n)));
  assert.equal(sdpAudioDirection(core.placed[0].sdp), "sendrecv");
});

test("a muted call keeps its sender: mute flips track.enabled only", async (t) => {
  const { mgr, emit, track } = setup(t);
  emit("incoming-call", { msgId: 9, chatId: 2 });
  await settle();
  await mgr.acceptIncoming();
  assert.equal(mgr.toggleMute(), true);
  assert.equal(track.enabled, false);
  assert.ok(mgr.pc.getSenders().some((s) => s.track === track));
});

test("getUserMedia without an audio track fails the call instead of sending silence", async (t) => {
  const { mgr } = setup(t, { gum: async () => ({ getAudioTracks: () => [], getTracks: () => [] }) });
  assert.equal(await mgr.startOutgoing(1, "Bob"), false);
  assert.equal(mgr.state, "ended");
});

test("Android: earpiece after getUserMedia, toggles, stops after the tracks", async (t) => {
  const { mgr, emit, route, order } = setup(t);
  await mgr.startOutgoing(1, "Bob");
  await settle();
  assert.deepEqual(route.calls[0], ["start", false, true]);
  assert.equal(mgr.route, "earpiece");
  assert.deepEqual(mgr.controls(), ["mute", "camera", "hangup", "speaker"]);
  emit("outgoing-call-accepted", { msgId: 77, acceptCallInfo: sdpFor("sendrecv", "sendrecv") });
  await settle();
  assert.equal(await mgr.toggleSpeaker(), true);
  assert.deepEqual(route.calls.at(-1), ["speaker", true, false]); // a tap forces the loudspeaker
  assert.equal(mgr.route, "speaker");
  assert.equal(await mgr.toggleSpeaker(), false);
  mgr.hangUp();
  await settle();
  assert.deepEqual(route.calls.at(-1), ["stop"]);
  assert.ok(order.indexOf("audio.stop") < order.indexOf("route.stop"), order.join(","));
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
  assert.deepEqual(mgr.controls(), ["mute", "camera", "hangup"]);
  assert.equal(await mgr.toggleSpeaker(), false);
  mgr.hangUp();
  await settle();
  assert.deepEqual(route.calls, []);
});

test("status line: Ringing, Connecting, Reconnecting, then the duration", async (t) => {
  const { mgr, emit } = setup(t);
  await mgr.startOutgoing(1, "Bob");
  assert.equal(mgr.statusText(), "Ringing…");
  emit("outgoing-call-accepted", { msgId: 77, acceptCallInfo: "v=0\r\n" });
  await settle();
  assert.equal(mgr.statusText(), "Connecting…");
  mgr.connectedAt = Date.now() - 65000;
  mgr.phase = "";
  assert.equal(mgr.statusText(), "01:05");
  mgr.phase = "reconnecting";
  assert.equal(mgr.statusText(), "Reconnecting…");
});

test("peer info: name, address, color and photo URL for the call screen", async (t) => {
  const { mgr } = setup(t);
  await mgr.startOutgoing(1, "B");
  await settle();
  assert.deepEqual(mgr.peer, { name: "Bob", addr: "bob@example.org", color: "#a33", avatarUrl: "" });
  assert.equal(mgr.chatName, "Bob");
});

test("shellAudioRoute is unsupported outside the Android shell (node, PWA)", () => {
  assert.equal(shellAudioRoute().supported, false);
});

test("defaults: earpiece for audio, loudspeaker for video; camera front first", () => {
  assert.equal(defaultSpeakerOn(false), false);
  assert.equal(defaultSpeakerOn(true), true);
  assert.equal(cameraConstraints().video.facingMode.ideal, "user");
  assert.equal(cameraConstraints("environment").video.facingMode.ideal, "environment");
  assert.deepEqual(cameraConstraints("user", "cam1").video.deviceId, { exact: "cam1" });
});

test("avatar initial: first letter (also non-Latin), ? when empty", () => {
  assert.equal(avatarInitial("bob"), "B");
  assert.equal(avatarInitial("  ёжик"), "Ё");
  assert.equal(avatarInitial(""), "?");
});

test("buttons: round icon buttons, labels, aria-pressed toggles, slashed icons when off", () => {
  const html = callButtonsHtml(["mute", "camera", "hangup", "speaker", "flip"], { muted: false, speaker: false, video: false });
  for (const [call, label] of [["mute", "Mute"], ["camera", "Camera"], ["hangup", "End call"], ["speaker", "Speaker"], ["flip", "Switch camera"]]) {
    assert.match(html, new RegExp(`data-call="${call}"[^>]*aria-label="${label}"`));
  }
  assert.match(html, /data-call="mute"[^>]*aria-pressed="false"/);
  assert.match(html, /data-call="camera"[^>]*aria-pressed="false"/);
  assert.match(html, /data-call="speaker"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(html, /data-call="hangup"[^>]*aria-pressed/);
  assert.ok(html.includes(CALL_ICONS.mic) && html.includes(CALL_ICONS.cameraOff) && html.includes(CALL_ICONS.hangup));
  const on = callButtonsHtml(["mute", "camera", "speaker"], { muted: true, speaker: true, video: true });
  assert.match(on, /data-call="mute" class="call-btn call-mute on"[^>]*aria-pressed="true"/);
  assert.match(on, /data-call="camera"[^>]*aria-pressed="true"/);
  assert.match(on, /data-call="speaker"[^>]*aria-pressed="true"/);
  assert.ok(on.includes(CALL_ICONS.micOff) && on.includes(CALL_ICONS.camera));
  assert.ok(CALL_ICONS.micOff.includes("M4 4l16 16"), "muted mic is slashed");
  assert.ok(/<svg viewBox="0 0 24 24" aria-hidden="true"/.test(CALL_ICONS.hangup));
  assert.equal(callButtonsHtml(["hangup"]).includes("speaker"), false);
});

test("sdp helpers", () => {
  const sdp = "v=0\r\nm=video 9 X 96\r\na=recvonly\r\nm=audio 9 X 111\r\na=sendrecv\r\n";
  assert.equal(sdpAudioDirection(sdp), "sendrecv");
  assert.equal(sdpDirection(sdp, "video"), "recvonly");
  assert.equal(sdpAudioDirection("v=0\r\nm=audio 9 X 111\r\n"), "sendrecv");
  assert.equal(sdpAudioDirection("v=0\r\n"), "none");
  assert.equal(sdpHasVideo(sdp), true);
  assert.equal(sdpHasVideo("v=0\r\nm=video 0 X 96\r\n"), false);
  assert.equal(sdpHasVideo("v=0\r\nm=audio 9 X 111\r\n"), false);
});

test("shell wiring: call_audio_* commands with the auto flag, CallAudio cached, video button", () => {
  const lib = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const cmd of ["call_audio_start", "call_audio_speaker", "call_audio_stop"]) {
    assert.match(lib, new RegExp(`generate_handler!\\[[^\\]]*\\b${cmd}\\b`), `${cmd} registered`);
  }
  assert.match(lib, /\("CallAudio", &APP_CALL_AUDIO_CLASS\)/);
  assert.match(lib, /\(Landroid\/content\/Context;ZZ\)Ljava\/lang\/String;/);
  const kt = readFileSync(new URL("../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/CallAudio.kt", import.meta.url), "utf8");
  assert.match(kt, /fun start\(context: Context, speakerOn: Boolean, autoRoute: Boolean\): String/);
  assert.match(kt, /fun setSpeaker\(context: Context, on: Boolean, autoRoute: Boolean\): String/);
  assert.match(kt, /fun stop\(context: Context\)/);
  assert.match(kt, /MODE_IN_COMMUNICATION/);
  assert.match(kt, /TYPE_BUILTIN_EARPIECE/);
  assert.match(kt, /MODE_NORMAL/);
  const manifest = readFileSync(new URL("../velta-app/src-tauri/gen/android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  for (const p of ["RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS", "CAMERA"]) assert.match(manifest, new RegExp(`android\\.permission\\.${p}`));
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  assert.match(html, /id="btn-video-call"[^>]*aria-label="Video call"/);
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app, /label: "Video call", onClick: \(\) => startCallIfMicOk\(chat, \{ video: true \}\)/);
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 479px\) \{ #btn-video-call \{ display: none; \} \}/);
});
