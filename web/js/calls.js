// calls.js — audio and video calls over the core's e2e-encrypted signaling
// with WebRTC media in the WebView.
//
// Division of labor: the core carries the call *signaling* (offer/answer
// SDP strings ride in encrypted messages, one message per direction; the
// core cannot renegotiate) and keeps call state across devices. This module
// owns the *media*: an RTCPeerConnection fed with the relay-provided ICE
// servers, the microphone, the camera and the remote streams.
//
// Interop with Delta Chat (deltachat/calls-webapp, used by DC Android,
// Desktop and iOS) — see docs/agents/calls.md:
// - every offer carries an audio AND a video transceiver (sendrecv), also
//   for audio calls, so the camera can be turned on mid-call without a
//   second offer/answer round (the core carries exactly one of each);
// - camera on/off = replaceTrack(camTrack | null) on that video sender;
// - two negotiated data channels: id 1 "iceTrickling" (late ICE candidates,
//   JSON RTCIceCandidateInit or null) and id 3 "mutedState"
//   ({audioEnabled, videoEnabled}) — DC hides our video when we report
//   videoEnabled:false, and we hide theirs the same way;
// - `has_video` of place_outgoing_call only labels the call ("video call").
//
// Everything platform-shaped (RTCPeerConnection, getUserMedia, device
// enumeration, the Android audio route, the peer's profile) is injected so
// the state machine runs headless in tests.
//
// #141: the microphone track MUST be on a sender before createOffer /
// createAnswer, or the SDP says recvonly and the peer hears nothing.

import { wakeLockAcquire, wakeLockRelease } from "./wakelock.js";
import { formatDuration } from "./format.js";
import { VELTA_DEBUG, diagnosticsSink } from "./diagnostics.js";
import { invoke, isAndroid, isTauri } from "./tauri.js";

const GATHER_TIMEOUT = 3000; // ICE gathering ceiling before sending anyway
const ENDED_VISIBLE_MS = 2500; // how long the ended overlay stays readable

// Voice capture: echo canceller and gain control matter most on a phone
// held to the ear (earpiece) or on the loudspeaker.
// Same server and public credentials as core create_fallback_ice_servers().
export const FALLBACK_ICE_SERVERS = [{
  urls: ["turn:turn.delta.chat:3478"],
  username: "public",
  credential: "o4tR7yG4rG2slhXqRUf9zgmHz",
}];

export const MIC_CONSTRAINTS = Object.freeze({
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false,
});

// Camera capture: modest resolution (calls ride TURN relays), front camera
// first like Delta Chat ({ideal: "user"}).
export function cameraConstraints(facing = "user", deviceId = "") {
  const video = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: facing };
  return { audio: false, video };
}

// Audio calls start on the earpiece (like a phone call); video calls on the
// loudspeaker (the phone is not at the ear). A headset wins in both cases.
export function defaultSpeakerOn(hasVideo) {
  return !!hasVideo;
}

// Android audio route (earpiece / loudspeaker / headset) through the Tauri
// shell -> Kotlin CallAudio.kt. `auto` = an automatic switch (call start,
// camera on/off): a connected headset keeps the audio. A tap on Speaker or
// Earpiece is not auto: it forces that side. Desktop and the PWA have no
// earpiece: supported=false and both buttons stay hidden.
export function shellAudioRoute() {
  const supported = isTauri() && isAndroid();
  return {
    supported,
    start: (speaker, auto = true) => invoke("call_audio_start", { speaker, auto }),
    setSpeaker: (on, auto = false) => invoke("call_audio_speaker", { on, auto }),
    stop: () => invoke("call_audio_stop"),
  };
}

function sdpSection(sdp, kind) {
  const text = String(sdp || "");
  const at = text.search(new RegExp(`^m=${kind} `, "m"));
  if (at < 0) return null;
  const rest = text.slice(at + 1);
  const next = rest.search(/^m=/m);
  return "m" + (next < 0 ? rest : rest.slice(0, next)); // rest starts after the "m"
}

// Direction of the first audio m-line of an SDP (sendrecv/sendonly/recvonly/
// inactive), for the debug log; "none" when there is no audio section.
export function sdpAudioDirection(sdp) {
  return sdpDirection(sdp, "audio");
}

export function sdpDirection(sdp, kind) {
  const section = sdpSection(sdp, kind);
  if (section == null) return "none";
  const m = section.match(/^a=(sendrecv|sendonly|recvonly|inactive)\s*$/m);
  return m ? m[1] : "sendrecv"; // RFC 4566: sendrecv when absent
}

// True when the SDP has a usable video m-line (port != 0): only then can
// the camera be turned on in this call (no renegotiation through the core).
export function sdpHasVideo(sdp) {
  const section = sdpSection(sdp, "video");
  if (section == null) return false;
  return !/^m=video 0 /.test(section);
}

// The first letter of a name (or address) for the avatar fallback.
export function avatarInitial(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const first = Array.from(s)[0];
  return first.toLocaleUpperCase();
}

// Call trace for device debugging (#141). Only with VELTA_DEBUG (debug CI
// builds, localStorage velta-debug=1, ?debug): lines land in the Diagnostics
// chat (readable on a release APK, where the WebView console never reaches
// logcat) and, with Diagnostics -> Logging on, in velta.log via js_log.
function callDebugLog(msg) {
  if (!VELTA_DEBUG) return;
  try { console.log("[velta] [call]", msg); } catch {}
  try { diagnosticsSink.append("info", `[call] ${msg}`); } catch {}
}

// Mic/camera permission before getUserMedia (accept, accept with video,
// camera on mid-call, flip, outgoing). Android: CallPermissions.kt checks
// the runtime permission and shows the OS dialog itself (`call_permission`),
// so a denied/never-asked CAMERA no longer surfaces as a bare getUserMedia
// NotAllowedError; wry's onPermissionRequest then grants the WebView
// request. Desktop/PWA: navigator.permissions (a "denied" short-circuits,
// "prompt" lets getUserMedia raise the browser prompt).
// Result: "granted" | "prompt" (let getUserMedia ask) | "denied".
export async function ensureMediaPermission(kind, deps = {}) {
  const native = deps.native === undefined ? shellPermission() : deps.native;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? 120000;
  try {
    if (native) {
      let r = String(await native(kind, true));
      // The OS dialog is up: poll until the user answers it.
      for (let waited = 0; r === "pending" && waited < timeoutMs; waited += 250) {
        await sleep(250);
        r = String(await native(kind, false));
      }
      if (r === "granted") return "granted";
      if (r === "denied" || r === "blocked") return "denied";
      return "prompt";
    }
    const query = deps.query || globalThis.navigator?.permissions?.query?.bind(globalThis.navigator.permissions);
    if (!query) return "prompt";
    const st = await query({ name: kind === "camera" ? "camera" : "microphone" });
    if (st?.state === "denied") return "denied";
    return st?.state === "granted" ? "granted" : "prompt";
  } catch {
    return "prompt"; // API or name unsupported — let getUserMedia decide
  }
}

function shellPermission() {
  if (!(isTauri() && isAndroid())) return null;
  return (kind, request) => invoke("call_permission", { kind, request });
}

export const CAMERA_DENIED_MSG = "Camera access is blocked — the call continues with audio only. Allow the camera for Velta in system settings (Android: App info → Permissions → Camera).";
export const MIC_DENIED_MSG = "Microphone access is blocked — Velta can't take the call. Allow the microphone for Velta in system settings (Android: App info → Permissions → Microphone).";

export function initCalls(core, opts = {}) {
  const mgr = new CallManager(core, opts.rtcpFactory, opts.getUserMedia, opts.notify, opts.audioRoute, opts.log, opts);
  mgr.bind();
  return mgr;
}

export class CallManager extends EventTarget {
  // extra: { enumerateDevices, peerInfo(chatId) -> {name, addr, color, avatarUrl} }
  constructor(core, rtcpFactory, getUserMedia, notify, audioRoute, log, extra = {}) {
    super();
    this.core = core;
    this._rtcpFactory = rtcpFactory || ((cfg) => new RTCPeerConnection(cfg));
    this._getUserMedia = getUserMedia || ((c) => navigator.mediaDevices.getUserMedia(c));
    this._enumerateDevices = extra.enumerateDevices ||
      (() => globalThis.navigator?.mediaDevices?.enumerateDevices?.() ?? Promise.resolve([]));
    this._peerInfo = extra.peerInfo || (async (chatId) => {
      const chat = await this.core.getChat?.(chatId);
      return { name: chat?.name || "", color: chat?.avatarColor || "", avatarUrl: "" };
    });
    this._notify = notify || (() => {});
    this._route = audioRoute || shellAudioRoute();
    this._permission = extra.permission || ((kind) => ensureMediaPermission(kind));
    this._log = log || callDebugLog;
    this._routeOps = Promise.resolve(); // shell route calls run in order
    this.reset();
  }

  reset() {
    this.state = "idle"; // idle|incoming|outgoing|active|ended
    this.phase = ""; // status detail: calling|ringing|connecting|reconnecting
    this.endLabel = "";
    this.callMsgId = null;
    this.chatId = null;
    this.chatName = "";
    this.peer = { name: "", addr: "", color: "", avatarUrl: "" };
    this.pc = null;
    this.localStream = null; // mic (+ camera track while video is on)
    this.camTrack = null;
    this.videoTx = null; // the video transceiver, null = no video in this call
    this.remoteStream = null;
    this.remoteMuted = null; // the peer's {audioEnabled, videoEnabled} (data channel)
    this.remoteVideoOn = false;
    this.dcMuted = null;
    this.dcIce = null;
    this.iceBuffer = [];
    this.sdpSent = false;
    this.muted = false;
    this.videoOn = false;
    this.facing = "user";
    this.cameraCount = 0;
    this.speaker = false; // loudspeaker on (Android route); false = earpiece/headset
    this.route = ""; // what the shell reported: earpiece|speaker|wired|bluetooth|usb|…
    this.routeActive = false;
    this.hasVideo = false; // the call was placed as a video call
    this.connectedAt = 0;
    this.endedVisibleMs = ENDED_VISIBLE_MS;
    this.durationTimer = null;
  }

  bind() {
    this.core.addEventListener("incoming-call", (e) => this.onIncomingCall(e?.detail || {}));
    this.core.addEventListener("outgoing-call-accepted", (e) => this.onOutgoingAccepted(e?.detail || {}));
    this.core.addEventListener("incoming-call-accepted", (e) => this.onIncomingAcceptedElsewhere(e?.detail || {}));
    this.core.addEventListener("call-ended", (e) => this.onCallEnded(e?.detail || {}));
    this.core.addEventListener("account-changing", () => this.teardown(true));
  }

  async loadPeer(chatId, fallbackName) {
    try {
      const p = (await this._peerInfo(chatId)) || {};
      this.peer = { name: p.name || fallbackName || "", addr: p.addr || "", color: p.color || "", avatarUrl: p.avatarUrl || "" };
    } catch {
      this.peer = { name: fallbackName || "", addr: "", color: "", avatarUrl: "" };
    }
    if (this.peer.name) this.chatName = this.peer.name;
    if (this.state !== "idle") this.render();
  }

  /* ---------------- outgoing ---------------- */

  async startOutgoing(chatId, chatName, { video = false } = {}) {
    if (this.state !== "idle") return false;
    this.state = "outgoing";
    this.phase = "calling";
    this.chatId = chatId;
    this.chatName = chatName;
    this.peer = { ...this.peer, name: chatName || "" };
    this.hasVideo = !!video;
    this.speaker = defaultSpeakerOn(video);
    this.render();
    this.loadPeer(chatId, chatName);
    if ((await this._permission("microphone")) === "denied") {
      this._notify(MIC_DENIED_MSG);
      this.finish("Mic unavailable");
      return false;
    }
    try {
      this.localStream = await this.openMic();
    } catch (err) {
      this._log(`getUserMedia failed: ${err?.name || ""} ${err?.message || err}`);
      this._notify("Microphone unavailable: " + (err?.message || err));
      this.finish("Mic unavailable");
      return false;
    }
    if (video) await this.openCamera(); // failure = audio-only, told in a toast
    wakeLockAcquire(); // the screen must not sleep mid-call
    this.startRoute();
    try {
      const cfg = { iceServers: await this.safeIceServers(), bundlePolicy: "max-bundle" };
      this.pc = this._rtcpFactory(cfg);
      this.openDataChannels();
      this.attachMedia();
      this.addLocalTracks(); // before createOffer, or the offer is recvonly
      this.render();
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await gatherComplete(this.pc);
      const sdp = this.pc.localDescription.sdp;
      this._log(`offer audio=${sdpDirection(sdp, "audio")} video=${sdpDirection(sdp, "video")} hasVideo=${this.hasVideo}`);
      this.callMsgId = Number(await this.core.placeOutgoingCall(chatId, sdp, this.hasVideo));
      this.sdpSent = true;
      this.phase = "ringing";
      this.render();
      return true;
    } catch (err) {
      this._notify("Call failed: " + (err?.message || err));
      try { if (this.callMsgId) await this.core.endCall(this.callMsgId); } catch {}
      this.finish("Call failed");
      return false;
    }
  }

  /* ---------------- incoming ---------------- */

  async onIncomingCall(d) {
    if (this.state !== "idle") return;
    this.state = "incoming";
    this.phase = "";
    this.callMsgId = Number(d.msgId);
    this.chatId = Number(d.chatId);
    this.hasVideo = !!d.hasVideo;
    this.chatName = "Incoming call";
    this.render();
    await this.loadPeer(this.chatId, "");
    if (!this.peer.name) this.chatName = "Incoming call";
    this.render();
    this._notify(`Incoming ${this.hasVideo ? "video " : ""}call — ${this.chatName}`);
  }

  // withVideo: undefined = as offered (camera on for a video call).
  async acceptIncoming(withVideo) {
    if (this.state !== "incoming") return;
    const msgId = this.callMsgId;
    const video = withVideo === undefined ? this.hasVideo : !!withVideo;
    // Mic first (the OS dialog may come up): a blocked mic keeps the call
    // ringing so it can still be declined, or accepted after allowing it.
    if (this._acceptBusy) return;
    this._acceptBusy = true;
    let mic;
    try { mic = await this._permission("microphone"); } finally { this._acceptBusy = false; }
    if (this.state !== "incoming" || this.callMsgId !== msgId) return;
    if (mic === "denied") {
      this._notify(MIC_DENIED_MSG);
      return;
    }
    this.speaker = defaultSpeakerOn(video);
    this.phase = "connecting";
    this.state = "accepting";
    this.render();
    try {
      this.localStream = await this.openMic();
      wakeLockAcquire(); // the screen must not sleep mid-call
      const info = await this.core.callInfo(msgId);
      const offerHasVideo = sdpHasVideo(info.sdpOffer);
      if (video && offerHasVideo) await this.openCamera();
      this.startRoute();
      const cfg = { iceServers: await this.safeIceServers(), bundlePolicy: "max-bundle" };
      this.pc = this._rtcpFactory(cfg);
      this.openDataChannels();
      this.attachMedia();
      this._log(`remote offer audio=${sdpDirection(info.sdpOffer, "audio")} video=${sdpDirection(info.sdpOffer, "video")} hasVideo=${!!info.hasVideo}`);
      await this.pc.setRemoteDescription({ type: "offer", sdp: info.sdpOffer });
      // After the remote offer, so the offer's transceivers are reused (the
      // Delta Chat webapp does the same); before createAnswer, or the
      // answer is recvonly and the peer hears nothing.
      this.addLocalTracks();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await gatherComplete(this.pc);
      const sdp = this.pc.localDescription.sdp;
      this._log(`answer audio=${sdpDirection(sdp, "audio")} video=${sdpDirection(sdp, "video")}`);
      await this.core.acceptIncomingCall(msgId, sdp);
      this.sdpSent = true;
      this.flushIce();
      this.state = "active";
      this.startTimer();
      this.render();
    } catch (err) {
      this._notify("Call failed: " + (err?.message || err));
      try { if (msgId) await this.core.endCall(msgId); } catch {}
      this.finish("Call failed");
    }
  }

  declineIncoming() {
    // end_call covers decline: the peer sees a declined call, not a missed one.
    if (this.callMsgId) this.core.endCall(this.callMsgId).catch(() => {});
    this.teardown(true);
  }

  /* ---------------- core events ---------------- */

  async onOutgoingAccepted(d) {
    if (this.state !== "outgoing" || Number(d.msgId) !== this.callMsgId) return;
    try {
      this._log(`remote answer audio=${sdpDirection(d.acceptCallInfo, "audio")} video=${sdpDirection(d.acceptCallInfo, "video")}`);
      await this.pc.setRemoteDescription({ type: "answer", sdp: d.acceptCallInfo });
      this.flushIce();
      this.state = "active";
      this.phase = "connecting";
      this.startTimer();
      this.render();
    } catch (err) {
      this._notify("Call failed: " + (err?.message || err));
      this.teardown(true);
    }
  }

  // Another device of this account accepted the incoming call — stand down.
  onIncomingAcceptedElsewhere(d) {
    if (this.state !== "incoming" || !d || d.fromThisDevice) return;
    if (Number(d.msgId) !== this.callMsgId) return;
    this.finish("Accepted on another device");
  }

  onCallEnded(d) {
    if (this.state === "idle") return;
    if (d && this.callMsgId && Number(d.msgId) !== this.callMsgId) return;
    const label = this.state === "outgoing" ? "No answer" : this.state === "incoming" ? "Missed call" : "Call ended";
    this.finish(label);
  }

  /* ---------------- call controls ---------------- */

  // Buttons for the current state, in screen order: mic, camera, end,
  // speaker, earpiece, flip. Both audio buttons show on Android; .on marks
  // the active one.
  controls() {
    const s = this.state;
    if (s === "incoming") return this.hasVideo ? ["decline", "accept", "accept-video"] : ["decline", "accept"];
    if (s === "ended" || s === "idle") return [];
    if (!this.pc) return ["hangup"];
    const out = ["mute"];
    if (this.videoTx) out.push("camera");
    out.push("hangup");
    if (this._route?.supported) out.push("speaker", "earpiece");
    if (this.videoOn && this.cameraCount > 1) out.push("flip");
    return out;
  }

  statusText() {
    if (this.state === "ended") return this.endLabel;
    if (this.state === "incoming") return this.hasVideo ? "Incoming video call…" : "Incoming call…";
    if (this.phase === "reconnecting") return "Reconnecting…";
    if (this.state === "active" && this.connectedAt) return formatDuration(Math.floor((Date.now() - this.connectedAt) / 1000));
    if (this.state === "active" || this.state === "accepting" || this.phase === "connecting") return "Connecting…";
    if (this.phase === "ringing") return "Ringing…";
    return "Calling…";
  }

  toggleMute() {
    if (!this.localStream) return this.muted;
    this.muted = !this.muted;
    for (const t of this.localStream.getAudioTracks()) t.enabled = !this.muted;
    this._log(`mute=${this.muted}`);
    this.sendMutedState();
    this.render();
    return this.muted;
  }

  // Speaker or earpiece (Android). A tap forces that side (not auto), so a
  // repeat tap can pull audio off a headset. The highlight flips at once;
  // the shell's answer (the actual route, e.g. "wired") lands in this.route.
  async setSpeaker(on) {
    if (!this._route?.supported || this.state === "idle" || this.state === "ended") return this.speaker;
    this.speaker = !!on;
    this.render();
    await this.applySpeaker(false);
    return this.speaker;
  }

  async applySpeaker(auto) {
    if (!this._route?.supported || !this.routeActive) return;
    try {
      const on = this.speaker;
      this.route = String((await this.queueRoute(() => this._route.setSpeaker(on, auto))) || "");
      this._log(`speaker=${on} auto=${auto} route=${this.route}`);
    } catch (err) {
      this._log(`setSpeaker failed: ${err?.message || err}`);
      if (!auto) this._notify("Couldn't switch the speaker: " + (err?.message || err));
    }
  }

  // Camera on/off mid-call: replaceTrack on the video transceiver every
  // offer carries (no renegotiation), mutedState tells the peer. The camera
  // is released while off. Video on -> loudspeaker (unless a headset),
  // video off -> earpiece.
  async toggleVideo() {
    if (!this.videoTx || !this.pc) return this.videoOn;
    if (this._videoBusy) return this.videoOn;
    this._videoBusy = true;
    try {
      if (!this.videoOn) {
        if (!(await this.openCamera())) return false;
        try {
          await this.videoTx.sender.replaceTrack(this.camTrack);
        } catch (err) {
          this.stopCamera();
          throw err;
        }
      } else {
        await this.videoTx.sender.replaceTrack(null);
        this.stopCamera();
      }
      this._log(`video=${this.videoOn}`);
      this.sendMutedState();
      this.speaker = this.videoOn;
      this.render();
      await this.applySpeaker(true);
      return this.videoOn;
    } catch (err) {
      this._log(`toggleVideo failed: ${err?.message || err}`);
      this._notify("Camera unavailable: " + (err?.message || err));
      return this.videoOn;
    } finally {
      this._videoBusy = false;
    }
  }

  // Front <-> back. Phones cannot open two cameras at once: stop first.
  async flipCamera() {
    if (!this.videoOn || !this.videoTx || this._videoBusy) return this.facing;
    this._videoBusy = true;
    const next = this.facing === "user" ? "environment" : "user";
    const oldId = this.camTrack?.getSettings?.().deviceId || "";
    try {
      this.stopCamera(true);
      let ok = await this.openCamera(next, "", true);
      if (!ok) {
        // facingMode unsupported (desktop webcams): cycle the device list.
        const cams = (await this._enumerateDevices().catch(() => [])).filter((d) => d.kind === "videoinput");
        const i = cams.findIndex((c) => c.deviceId === oldId);
        const pick = cams[(i + 1) % Math.max(cams.length, 1)];
        ok = await this.openCamera(next, pick?.deviceId || "");
      }
      if (ok) {
        await this.videoTx.sender.replaceTrack(this.camTrack);
      } else {
        // No camera at all now: video off, tell the peer, back to earpiece.
        await this.videoTx.sender.replaceTrack(null).catch(() => {});
        this.stopCamera();
        this.sendMutedState();
        this.speaker = false;
        this.applySpeaker(true);
      }
      this._log(`flip -> ${this.facing} ok=${ok}`);
      this.render();
    } catch (err) {
      this._log(`flip failed: ${err?.message || err}`);
    } finally {
      this._videoBusy = false;
    }
    return this.facing;
  }

  hangUp() {
    if (this.callMsgId) {
      this.core.endCall(this.callMsgId).catch(() => {});
    }
    this.teardown(true);
  }

  /* ---------------- internals ---------------- */

  async openMic() {
    const stream = await this._getUserMedia(MIC_CONSTRAINTS);
    const tracks = stream?.getAudioTracks?.() || [];
    this._log(`mic: ${tracks.length} track(s)` + tracks.map((t) =>
      ` [${t.label || "?"} enabled=${t.enabled} muted=${t.muted} state=${t.readyState}]`).join(""));
    if (!tracks.length) throw new Error("no microphone track");
    return stream;
  }

  // Opens the camera into this.camTrack; false (and a toast unless quiet)
  // when it fails — the call goes on audio-only.
  async openCamera(facing = this.facing, deviceId = "", quiet = false) {
    // Check / ask the camera permission first (Android runtime CAMERA).
    // Denied: no getUserMedia, audio-only, camera button stays off.
    if ((await this._permission("camera")) === "denied") {
      this._log("camera permission denied");
      if (!quiet) this._notify(CAMERA_DENIED_MSG);
      return false;
    }
    try {
      const s = await this._getUserMedia(cameraConstraints(facing, deviceId));
      const t = s?.getVideoTracks?.()[0];
      if (!t) throw new Error("no camera track");
      this.camTrack = t;
      const f = t.getSettings?.().facingMode;
      this.facing = f === "environment" || f === "user" ? f : facing;
      this.videoOn = true;
      try { this.localStream?.addTrack?.(t); } catch {}
      this._log(`camera: [${t.label || "?"} facing=${this.facing} state=${t.readyState}]`);
      if (!this.cameraCount) {
        const devs = await this._enumerateDevices().catch(() => []);
        this.cameraCount = (devs || []).filter((d) => d.kind === "videoinput").length;
      }
      this.showLocalVideo();
      return true;
    } catch (err) {
      this._log(`camera failed: ${err?.name || ""} ${err?.message || err}`);
      if (!quiet) this._notify("Camera unavailable: " + (err?.message || err));
      return false;
    }
  }

  stopCamera(keepFlag = false) {
    const t = this.camTrack;
    if (t) {
      try { this.localStream?.removeTrack?.(t); } catch {}
      try { t.stop(); } catch {}
    }
    this.camTrack = null;
    if (!keepFlag) this.videoOn = false;
    this.showLocalVideo();
  }

  // #141 root cause: without this the mic was opened but never sent.
  // Caller: one audio and one video transceiver, both sendrecv (like the
  // Delta Chat webapp), so either side can turn its camera on later.
  // Callee: reuse the offer's transceivers; video only if the offer has it.
  addLocalTracks() {
    const stream = this.localStream;
    const mic = stream?.getAudioTracks?.()[0] || null;
    if (mic) mic.enabled = !this.muted;
    const streams = stream ? [stream] : [];
    const txs = this.pc.getTransceivers?.() || [];
    if (!txs.length) {
      // Caller (nothing negotiated yet).
      this.pc.addTransceiver(mic, { direction: "sendrecv", streams });
      this.videoTx = this.pc.addTransceiver(this.camTrack || "video", { direction: "sendrecv", streams });
    } else {
      let audioDone = false;
      for (const tx of txs) {
        const kind = tx.receiver?.track?.kind;
        if (kind === "audio") {
          audioDone = true; // addTrack below reuses this transceiver
        } else if (kind === "video" && !this.videoTx) {
          tx.direction = "sendrecv";
          if (this.camTrack) tx.sender.replaceTrack(this.camTrack);
          tx.sender.setStreams?.(...streams);
          this.videoTx = tx;
        }
      }
      // addTrack reuses the offer's audio transceiver and sets our stream
      // id (Delta Chat's ontrack reads e.streams[0]).
      if (mic) this.pc.addTrack(mic, stream);
      if (!audioDone) this._log("remote offer has no audio m-line");
      if (!this.videoTx && this.camTrack) this.stopCamera(); // offer has no video
    }
    const senders = this.pc.getSenders?.() || [];
    this._log(`tracks: mic=${!!mic} camera=${!!this.camTrack} videoTx=${!!this.videoTx}, ${senders.filter((s) => s.track).length} sender(s) with a track`);
  }

  // Negotiated data channels shared with Delta Chat's calls webapp.
  openDataChannels() {
    if (!this.pc.createDataChannel) return;
    try {
      this.dcIce = this.pc.createDataChannel("iceTrickling", { negotiated: true, id: 1 });
      this.dcIce.onopen = () => this.flushIce();
      this.dcIce.onmessage = (e) => {
        let cand;
        try { cand = JSON.parse(e.data); } catch { return; }
        this.pc?.addIceCandidate(cand ?? undefined).catch(() => {});
      };
      this.dcMuted = this.pc.createDataChannel("mutedState", { negotiated: true, id: 3 });
      this.dcMuted.onopen = () => this.sendMutedState();
      this.dcMuted.onmessage = (e) => {
        let o;
        try { o = JSON.parse(e.data); } catch { return; }
        if (!o || typeof o.audioEnabled !== "boolean" || typeof o.videoEnabled !== "boolean") return;
        this.remoteMuted = { audioEnabled: o.audioEnabled, videoEnabled: o.videoEnabled };
        this._log(`remote mutedState audio=${o.audioEnabled} video=${o.videoEnabled}`);
        this.updateRemoteVideo();
      };
      this.pc.addEventListener?.("icecandidate", (e) => {
        if (!this.sdpSent) return; // still in the SDP we are about to send
        this.iceBuffer.push(e.candidate ? e.candidate.toJSON?.() ?? e.candidate : null);
        this.flushIce();
      });
    } catch (err) {
      this._log(`data channels failed: ${err?.message || err}`);
    }
  }

  flushIce() {
    if (this.dcIce?.readyState !== "open") return;
    for (const c of this.iceBuffer.splice(0)) {
      try { this.dcIce.send(JSON.stringify(c)); } catch {}
    }
  }

  sendMutedState() {
    if (this.dcMuted?.readyState !== "open") return;
    try {
      this.dcMuted.send(JSON.stringify({ audioEnabled: !this.muted, videoEnabled: !!this.videoOn }));
    } catch {}
  }

  // Android: MODE_IN_COMMUNICATION + earpiece (audio) or loudspeaker
  // (video); a headset wins. Called after getUserMedia: the WebView
  // switches the audio mode itself when the capture starts.
  startRoute() {
    if (!this._route?.supported) return;
    this.routeActive = true;
    this.queueRoute(() => this._route.start(this.speaker, true))
      .then((r) => {
        this.route = String(r || "");
        this._log(`audio route start speaker=${this.speaker} route=${this.route}`);
      })
      .catch((err) => this._log(`audio route start failed: ${err?.message || err}`));
  }

  // Serialize shell route calls: a stop must never overtake a start.
  queueRoute(fn) {
    const op = this._routeOps.then(fn);
    this._routeOps = op.catch(() => {});
    return op;
  }

  // Re-assert the chosen route once media flows (the WebView may re-route
  // when the remote track starts playing).
  reapplyRoute(why) {
    if (!this._route?.supported || !this.routeActive) return;
    this.queueRoute(() => this._route.setSpeaker(this.speaker, true))
      .then((r) => {
        this.route = String(r || "");
        this._log(`audio route (${why}) speaker=${this.speaker} route=${this.route}`);
      })
      .catch((err) => this._log(`audio route (${why}) failed: ${err?.message || err}`));
  }

  // Back to MODE_NORMAL. After the tracks stopped: the WebView restores its
  // own saved audio state when capture ends, ours must be the last word.
  stopRoute() {
    if (!this.routeActive) return;
    this.routeActive = false;
    this.route = "";
    this.queueRoute(() => this._route.stop())
      .then(() => this._log("audio route stopped"))
      .catch((err) => this._log(`audio route stop failed: ${err?.message || err}`));
  }

  attachMedia() {
    this.pc.addEventListener?.("connectionstatechange", () => {
      const st = this.pc?.connectionState;
      this._log(`connection=${st}`);
      if (st === "connected") {
        if (this.phase === "connecting" || this.phase === "reconnecting") this.phase = "";
        if (this.state === "active" && !this.connectedAt) this.connectedAt = Date.now();
        this.reapplyRoute("connected");
        this.render();
      }
      if (this.pc && st === "failed") {
        this._notify("Call connection failed");
        this.teardown(true);
      }
    });
    this.pc.addEventListener?.("iceconnectionstatechange", () => {
      const st = this.pc?.iceConnectionState;
      this._log(`ice=${st}`);
      if (this.state !== "active") return;
      if (st === "disconnected") { this.phase = "reconnecting"; this.render(); }
      else if ((st === "connected" || st === "completed") && this.phase === "reconnecting") { this.phase = ""; this.render(); }
    });
    if (typeof MediaStream === "undefined") return; // headless (tests)
    this.remoteStream = new MediaStream();
    this.remoteAudio = new MediaStream();
    this.pc.addEventListener("track", (e) => {
      const t = e.track;
      if (!t) return;
      if (!this.remoteStream.getTrackById(t.id)) this.remoteStream.addTrack(t);
      if (t.kind === "audio" && !this.remoteAudio.getTrackById(t.id)) this.remoteAudio.addTrack(t);
      if (t.kind === "video") {
        t.addEventListener("mute", () => this.updateRemoteVideo());
        t.addEventListener("unmute", () => this.updateRemoteVideo());
      }
      this._log(`remote track kind=${t.kind} muted=${t.muted} streams=${e.streams?.length || 0}`);
      this.playRemote();
      this.updateRemoteVideo();
    });
    this.playRemote();
  }

  // Remote video shows when its track delivers frames (not muted) and the
  // peer has not reported videoEnabled:false (track.enabled=false on their
  // side sends black frames without muting the track here).
  updateRemoteVideo() {
    const vt = this.remoteStream?.getVideoTracks?.()[0];
    const on = !!vt && !vt.muted && vt.readyState !== "ended" && (this.remoteMuted == null || this.remoteMuted.videoEnabled);
    if (on !== this.remoteVideoOn) {
      this.remoteVideoOn = on;
      this._log(`remote video ${on ? "shown" : "hidden"}`);
      this.render();
    }
  }

  playRemote() {
    if (!this.remoteAudio || typeof document === "undefined") return;
    let audio = document.getElementById("call-remote-audio");
    if (!audio) {
      audio = document.createElement("audio");
      audio.id = "call-remote-audio";
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    // Re-assigning the same stream restarts the load and rejects the
    // pending play() ("interrupted by a new load request").
    if (audio.srcObject !== this.remoteAudio) audio.srcObject = this.remoteAudio;
    audio.play().catch((err) => this._log(`remote audio play() failed: ${err?.message || err}`));
  }

  // The core resolves TURN hostnames to IPs itself (Delta Chat Desktop can't
  // use DNS). In the PWA that lookup rides the wasm tunnel; when it fails the
  // core returns [] and the call would only have host candidates. A browser
  // RTCPeerConnection resolves names on its own, so fall back to the core's
  // own public fallback server by hostname.
  async safeIceServers() {
    let servers = [];
    try {
      const raw = await this.core.iceServers();
      servers = Array.isArray(raw) ? raw.filter((s) => s && s.urls) : [];
    } catch {}
    if (!servers.length) {
      this._log("ice_servers empty; using the turn.delta.chat fallback by hostname");
      return FALLBACK_ICE_SERVERS;
    }
    return servers;
  }

  startTimer() {
    if (this.durationTimer) return;
    if (this.pc?.connectionState === "connected" && !this.connectedAt) this.connectedAt = Date.now();
    const tick = () => {
      if (this.state !== "active" || typeof document === "undefined") return;
      const el = document.querySelector("#call-overlay .call-status");
      if (el) el.textContent = this.statusText();
    };
    tick();
    this.durationTimer = setInterval(tick, 1000);
  }

  // Final transition: brief "ended" display, then full teardown. Media
  // stops at once (mic/camera indicators off); the screen lingers.
  finish(label) {
    const wasActive = this.state === "active";
    const seconds = wasActive && this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1000) : 0;
    this.state = "ended";
    this.endLabel = label + (wasActive && seconds ? ` · ${formatDuration(seconds)}` : "");
    this.remoteVideoOn = false;
    this.releaseMedia();
    this.render();
    setTimeout(() => {
      if (this.state !== "ended") return;
      this.hideOverlay();
      this.reset();
    }, this.endedVisibleMs);
  }

  // Immediate teardown (decline, hangup, account switch): no ended display.
  teardown(silent) {
    if (this.state === "idle") return;
    this.releaseMedia();
    this.hideOverlay();
    this.reset();
    if (!silent) this._notify("Call ended");
  }

  releaseMedia() {
    wakeLockRelease();
    if (this.durationTimer) { clearInterval(this.durationTimer); this.durationTimer = null; }
    try { if (this.pc) this.pc.close(); } catch {}
    try { for (const t of this.localStream?.getTracks() || []) t.stop(); } catch {}
    try { this.camTrack?.stop(); } catch {}
    this.stopRoute();
    if (typeof document !== "undefined") {
      const audio = document.getElementById("call-remote-audio");
      if (audio) { audio.srcObject = null; audio.remove(); }
    }
    this.pc = null;
    this.localStream = null;
    this.camTrack = null;
    this.videoTx = null;
    this.remoteStream = null;
    this.remoteAudio = null;
    this.dcIce = null;
    this.dcMuted = null;
    this.connectedAt = this.state === "ended" ? this.connectedAt : 0;
    this.callMsgId = null;
  }

  hideOverlay() {
    if (typeof document === "undefined") return;
    document.getElementById("call-overlay")?.remove();
  }

  /* ---------------- overlay UI ---------------- */

  // The skeleton (remote video, avatar, local preview) is built once per
  // call so the <video> elements keep playing; render() updates the parts.
  ensureOverlay() {
    let box = document.getElementById("call-overlay");
    if (box) return box;
    box = document.createElement("div");
    box.id = "call-overlay";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.innerHTML = `
      <video class="call-remote-video" playsinline autoplay muted hidden></video>
      <div class="call-top">
        <div class="call-name"></div>
        <div class="call-status" role="status"></div>
      </div>
      <div class="call-avatar" aria-hidden="true"></div>
      <video class="call-local-video" playsinline autoplay muted hidden aria-label="Your camera"></video>
      <div class="call-actions"></div>`;
    document.body.appendChild(box);
    makeDraggable(box.querySelector(".call-local-video"), box);
    box.querySelector(".call-actions").addEventListener("click", (e) => {
      const b = e.target.closest?.("button[data-call]");
      if (!b) return;
      const a = b.dataset.call;
      if (a === "hangup") this.hangUp();
      else if (a === "accept") this.acceptIncoming(false);
      else if (a === "accept-video") this.acceptIncoming(true);
      else if (a === "decline") this.declineIncoming();
      else if (a === "mute") this.toggleMute();
      else if (a === "speaker" || a === "earpiece") this.setSpeaker(a === "speaker");
      else if (a === "camera") this.toggleVideo();
      else if (a === "flip") this.flipCamera();
    });
    return box;
  }

  showLocalVideo() {
    if (typeof document === "undefined") return;
    const v = document.querySelector("#call-overlay .call-local-video");
    if (!v) return;
    if (this.camTrack && typeof MediaStream !== "undefined") {
      if (v.srcObject?.getVideoTracks?.()[0] !== this.camTrack) v.srcObject = new MediaStream([this.camTrack]);
      v.hidden = false;
      v.classList.toggle("mirror", this.facing === "user");
      v.play?.().catch(() => {});
    } else {
      v.srcObject = null;
      v.hidden = true;
    }
  }

  render() {
    if (typeof document === "undefined") return; // headless (tests)
    if (this.state === "idle") return;
    const box = this.ensureOverlay();
    const name = this.peer.name || this.chatName || this.peer.addr || "Call";
    box.setAttribute("aria-label", `Call with ${name}`);
    box.querySelector(".call-name").textContent = name;
    box.querySelector(".call-status").textContent = this.statusText();
    const av = box.querySelector(".call-avatar");
    const avKey = `${this.peer.avatarUrl}|${this.peer.color}|${name}`;
    if (av.dataset.key !== avKey) {
      av.dataset.key = avKey;
      av.replaceChildren();
      av.style.background = this.peer.color || "";
      const initial = document.createElement("span");
      initial.className = "call-avatar-initial";
      initial.textContent = avatarInitial(name);
      av.appendChild(initial);
      if (this.peer.avatarUrl) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = this.peer.avatarUrl;
        img.addEventListener("error", () => img.remove());
        av.appendChild(img);
      }
    }
    const rv = box.querySelector(".call-remote-video");
    const showRemote = this.remoteVideoOn && this.state === "active";
    if (showRemote && this.remoteStream) {
      if (rv.srcObject !== this.remoteStream) rv.srcObject = this.remoteStream;
      rv.play?.().catch(() => {});
    }
    rv.hidden = !showRemote;
    av.hidden = showRemote;
    box.classList.toggle("video", showRemote);
    this.showLocalVideo();
    // Re-rendering replaces the buttons: keep keyboard focus on the same one.
    const actions = box.querySelector(".call-actions");
    const focused = actions.contains(document.activeElement) ? document.activeElement?.dataset?.call : null;
    actions.innerHTML = callButtonsHtml(this.controls(), {
      muted: this.muted, speaker: this.speaker, video: this.videoOn,
    });
    if (focused) actions.querySelector(`[data-call="${focused}"]`)?.focus();
  }
}

// Picture-in-picture preview: drag it anywhere inside the overlay.
function makeDraggable(el, area) {
  if (!el) return;
  let start = null;
  el.addEventListener("pointerdown", (e) => {
    const r = el.getBoundingClientRect();
    start = { x: e.clientX - r.left, y: e.clientY - r.top, id: e.pointerId };
    try { el.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const a = area.getBoundingClientRect(), r = el.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - start.x - a.left, 0), a.width - r.width);
    const y = Math.min(Math.max(e.clientY - start.y - a.top, 0), a.height - r.height);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  });
  const end = () => { start = null; };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

// Icons: 24-unit viewBox, currentColor, the same fill/stroke style as the
// header icons in index.html.
const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
const MIC = `<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" fill="currentColor"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`;
const SLASH = `<path d="M4 4l16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`;
const CAM = `<rect x="3" y="6.5" width="12.5" height="11" rx="2.2" fill="currentColor"/><path d="M16.5 10.5l4.5-3v9l-4.5-3z" fill="currentColor"/>`;
const PHONE = `<path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .57 3.6 1 1 0 0 1-.25 1z" fill="currentColor"/>`;
export const CALL_ICONS = Object.freeze({
  mic: svg(MIC),
  micOff: svg(MIC + SLASH),
  camera: svg(CAM),
  cameraOff: svg(CAM + SLASH),
  phone: svg(PHONE),
  // The handset turned 135° (receiver down) = hang up.
  hangup: svg(`<g transform="rotate(135 12 12)">${PHONE}</g>`),
  speaker: svg(`<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`),
  earpiece: svg(`<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/>`),
  flip: svg(`<path d="M5 9a7.5 7.5 0 0 1 13-2.5M19 15a7.5 7.5 0 0 1-13 2.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18.8 3v4h-4M5.2 21v-4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>`),
  video: svg(CAM),
});

// Overlay buttons, as markup. Pure (node-testable). Round icon buttons with
// a fixed accessible name; toggles carry their state in aria-pressed
// (Mute pressed = muted, Camera pressed = on, Speaker pressed = loudspeaker,
// Earpiece pressed = earpiece). Exactly one of Speaker / Earpiece is .on.
export function callButtonsHtml(actions, { muted = false, speaker = false, video = false } = {}) {
  const b = (call, cls, label, icon, pressed) =>
    `<button type="button" data-call="${call}" class="call-btn ${cls}" aria-label="${label}" title="${label}"` +
    (pressed === undefined ? "" : ` aria-pressed="${pressed ? "true" : "false"}"`) + `>${icon}</button>`;
  const btn = {
    mute: () => b("mute", "call-mute" + (muted ? " on" : ""), "Mute", muted ? CALL_ICONS.micOff : CALL_ICONS.mic, muted),
    camera: () => b("camera", "call-camera" + (video ? " on" : ""), "Camera", video ? CALL_ICONS.camera : CALL_ICONS.cameraOff, video),
    hangup: () => b("hangup", "danger", "End call", CALL_ICONS.hangup),
    speaker: () => b("speaker", "call-speaker" + (speaker ? " on" : ""), "Speaker", CALL_ICONS.speaker, !!speaker),
    earpiece: () => b("earpiece", "call-earpiece" + (speaker ? "" : " on"), "Earpiece", CALL_ICONS.earpiece, !speaker),
    flip: () => b("flip", "call-flip", "Switch camera", CALL_ICONS.flip),
    accept: () => b("accept", "accept", "Accept", CALL_ICONS.phone),
    "accept-video": () => b("accept-video", "accept", "Accept with video", CALL_ICONS.video),
    decline: () => b("decline", "danger", "Decline", CALL_ICONS.hangup),
  };
  return (actions || []).map((a) => btn[a]?.() || "").join("");
}

// Non-trickle ICE: resolve when gathering completes, or after the timeout
// with whatever candidates were gathered by then.
function gatherComplete(pc, timeout = GATHER_TIMEOUT) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const done = () => { cleanup(); resolve(); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, timeout);
    function on() {
      if (pc.iceGatheringState === "complete") done();
    }
    function cleanup() {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", on);
    }
    pc.addEventListener("icegatheringstatechange", on);
  });
}
