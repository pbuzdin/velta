import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CallManager, ensureMediaPermission, CAMERA_DENIED_MSG, MIC_DENIED_MSG } from "../app/js/calls.js";

// Mic/camera permission is checked (and on Android asked) BEFORE every
// getUserMedia: accept, accept with video, camera on mid-call, flip.

const VIDEO_OFFER = "v=0\r\nm=audio 9 X 111\r\na=sendrecv\r\nm=video 9 X 96\r\na=sendrecv\r\n";

class FakePC {
  constructor() { this.iceGatheringState = "complete"; this.localDescription = { type: "answer", sdp: "answer-sdp" }; }
  addEventListener() {}
  removeEventListener() {}
  createDataChannel() { return { addEventListener() {}, close() {}, readyState: "connecting" }; }
  addTrack(track) { return { track }; }
  addTransceiver(k) { return { kind: k, sender: { track: null, async replaceTrack(t) { this.track = t; } } }; }
  getTransceivers() { return []; }
  getSenders() { return []; }
  async createOffer() { return { type: "offer", sdp: "offer-sdp" }; }
  async createAnswer() { return { type: "answer", sdp: "answer-sdp" }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.appliedRemote = d; }
  close() {}
}

function makeManager(t, perms) {
  const listeners = new Map();
  const core = {
    addEventListener: (n, fn) => { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(fn); },
    acceptIncomingCall: async (msgId, sdp) => { accepted.push({ msgId, sdp }); },
    placeOutgoingCall: async () => 9,
    endCall: async () => {},
    callInfo: async () => ({ sdpOffer: VIDEO_OFFER, hasVideo: true }),
    iceServers: async () => [],
    getChat: async () => ({ name: "Alice" }),
  };
  const accepted = [];
  const gum = [];
  const notes = [];
  const asked = [];
  const audio = [{ kind: "audio", enabled: true, stop() {} }];
  const mgr = new CallManager(core, () => new FakePC(), async (c) => {
    gum.push(c);
    const v = c.video ? [{ kind: "video", stop() {}, getSettings: () => ({ facingMode: "user" }) }] : [];
    return { getAudioTracks: () => (c.audio ? audio : []), getVideoTracks: () => v, getTracks: () => [...audio, ...v], addTrack() {}, removeTrack() {} };
  }, (m) => notes.push(m), { supported: false }, () => {}, {
    permission: async (kind) => { asked.push(kind); return perms[kind]; },
    enumerateDevices: async () => [],
  });
  mgr.endedVisibleMs = 5;
  mgr.bind();
  t.after(() => mgr.teardown(true));
  const emit = (n, d) => { for (const fn of listeners.get(n) || []) fn({ detail: d }); };
  return { mgr, emit, gum, notes, asked, accepted };
}

const flush = () => new Promise((r) => setImmediate(r));

test("accept with video, camera denied: audio-only call, toast, camera off, no camera getUserMedia", async (t) => {
  const h = makeManager(t, { microphone: "granted", camera: "denied" });
  h.emit("incoming-call", { msgId: 5, chatId: 2, hasVideo: true });
  await flush();
  await h.mgr.acceptIncoming(true);
  assert.equal(h.mgr.state, "active");
  assert.deepEqual(h.asked, ["microphone", "camera"]);
  assert.equal(h.gum.length, 1);
  assert.equal(!!h.gum[0].video, false);
  assert.equal(h.mgr.videoOn, false);
  assert.ok(h.notes.includes(CAMERA_DENIED_MSG));
  assert.equal(h.accepted.length, 1);
});

test("accept with video, camera granted: the camera opens", async (t) => {
  const h = makeManager(t, { microphone: "granted", camera: "granted" });
  h.emit("incoming-call", { msgId: 6, chatId: 2, hasVideo: true });
  await flush();
  await h.mgr.acceptIncoming(true);
  assert.equal(h.mgr.state, "active");
  assert.equal(h.mgr.videoOn, true);
  assert.equal(h.gum.length, 2);
});

test("accept, mic denied: stays ringing (can decline / retry), no getUserMedia, toast", async (t) => {
  const h = makeManager(t, { microphone: "denied", camera: "granted" });
  h.emit("incoming-call", { msgId: 7, chatId: 2, hasVideo: false });
  await flush();
  await h.mgr.acceptIncoming(false);
  assert.equal(h.mgr.state, "incoming");
  assert.equal(h.gum.length, 0);
  assert.equal(h.accepted.length, 0);
  assert.ok(h.notes.includes(MIC_DENIED_MSG));
});

test("camera on mid-call, denied: stays off, toast, no getUserMedia", async (t) => {
  const h = makeManager(t, { microphone: "granted", camera: "denied" });
  h.mgr.state = "active";
  h.mgr.pc = new FakePC();
  h.mgr.videoTx = { sender: { async replaceTrack() { throw new Error("must not replace"); } } };
  assert.equal(await h.mgr.toggleVideo(), false);
  assert.equal(h.mgr.videoOn, false);
  assert.equal(h.gum.length, 0);
  assert.ok(h.notes.includes(CAMERA_DENIED_MSG));
});

test("outgoing call, mic denied: no call placed", async (t) => {
  const h = makeManager(t, { microphone: "denied" });
  assert.equal(await h.mgr.startOutgoing(3, "Bob"), false);
  assert.equal(h.gum.length, 0);
});

test("ensureMediaPermission: Android native request polls the OS dialog", async () => {
  const seq = ["pending", "pending", "granted"];
  const calls = [];
  const r = await ensureMediaPermission("camera", { native: async (k, req) => { calls.push([k, req]); return seq.shift(); }, sleep: async () => {} });
  assert.equal(r, "granted");
  assert.deepEqual(calls, [["camera", true], ["camera", false], ["camera", false]]);
  assert.equal(await ensureMediaPermission("camera", { native: async () => "blocked" }), "denied");
  assert.equal(await ensureMediaPermission("camera", { native: async () => "prompt" }), "prompt");
  assert.equal(await ensureMediaPermission("camera", { native: async () => { throw new Error("x"); } }), "prompt");
});

test("ensureMediaPermission: browser Permissions API (desktop/PWA)", async () => {
  const names = [];
  const q = (state) => async (d) => { names.push(d.name); return { state }; };
  assert.equal(await ensureMediaPermission("camera", { native: null, query: q("denied") }), "denied");
  assert.equal(await ensureMediaPermission("microphone", { native: null, query: q("prompt") }), "prompt");
  assert.equal(await ensureMediaPermission("camera", { native: null, query: q("granted") }), "granted");
  assert.deepEqual(names, ["camera", "microphone", "camera"]);
  assert.equal(await ensureMediaPermission("camera", { native: null, query: async () => { throw new TypeError("bad name"); } }), "prompt");
});

test("shell wiring: call_permission command, CallPermissions cached, result hooked", () => {
  const lib = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(lib, /generate_handler!\[[^\]]*\bcall_permission\b/);
  assert.match(lib, /\("CallPermissions", &APP_CALL_PERMISSIONS_CLASS\)/);
  assert.match(lib, /\(Landroid\/content\/Context;Ljava\/lang\/String;Z\)Ljava\/lang\/String;/);
  const dir = "../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/";
  const kt = readFileSync(new URL(dir + "CallPermissions.kt", import.meta.url), "utf8");
  assert.match(kt, /@JvmStatic\s+fun check\(context: Context, kind: String, request: Boolean\): String/);
  assert.match(kt, /"camera" -> Manifest\.permission\.CAMERA/);
  assert.match(kt, /"microphone" -> Manifest\.permission\.RECORD_AUDIO/);
  const main = readFileSync(new URL(dir + "MainActivity.kt", import.meta.url), "utf8");
  assert.match(main, /CallPermissions\.attach\(this\)/);
  assert.match(main, /CallPermissions\.onResult\(requestCode\)/);
});
