// calls.js — audio calls over the core's e2e-encrypted signaling with
// WebRTC media in the WebView.
//
// Division of labor: the core carries the call *signaling* (offer/answer
// SDP strings ride in encrypted messages, one message per direction —
// non-trickle ICE, candidates are gathered before the SDP is sent) and
// keeps call state across devices. This module owns the *media*: an
// RTCPeerConnection fed with the relay-provided ICE servers, the local
// microphone and the remote audio stream.
//
// Everything platform-shaped (RTCPeerConnection, getUserMedia, timers, the
// Android audio route) is injected so the state machine can be exercised in
// tests.
//
// #141: the microphone track MUST be added to the peer connection
// (addLocalTracks) before createOffer / createAnswer. Opening the mic alone
// only captures it: without a sender the SDP says recvonly and the peer
// hears nothing.

import { wakeLockAcquire, wakeLockRelease } from "./wakelock.js";
import { formatDuration } from "./format.js";
import { VELTA_DEBUG, diagnosticsSink } from "./diagnostics.js";
import { invoke, isAndroid, isTauri } from "./tauri.js";

const GATHER_TIMEOUT = 3000; // ICE gathering ceiling before sending anyway
const ENDED_VISIBLE_MS = 2500; // how long the ended overlay stays readable

// Voice-call capture: the WebView's echo canceller and gain control matter
// most on a phone held to the ear (earpiece) or on the loudspeaker.
export const MIC_CONSTRAINTS = Object.freeze({
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false,
});

// Audio calls start on the earpiece (like a phone call); a video call would
// start on the loudspeaker (the usual convention: the phone is not at the
// ear). Velta offers audio calls only, so hasVideo is false today.
export function defaultSpeakerOn(hasVideo) {
  return !!hasVideo;
}

// Android audio route (earpiece / loudspeaker / headset) through the Tauri
// shell -> Kotlin CallAudio.kt. Desktop and the PWA have no earpiece: the
// adapter reports supported=false and the speaker button stays hidden.
export function shellAudioRoute() {
  const supported = isTauri() && isAndroid();
  return {
    supported,
    start: (speaker) => invoke("call_audio_start", { speaker }),
    setSpeaker: (on) => invoke("call_audio_speaker", { on }),
    stop: () => invoke("call_audio_stop"),
  };
}

// Direction of the first audio m-line of an SDP (sendrecv/sendonly/recvonly/
// inactive), for the debug log; "none" when there is no audio section.
export function sdpAudioDirection(sdp) {
  const text = String(sdp || "");
  const at = text.search(/^m=audio /m);
  if (at < 0) return "none";
  const rest = text.slice(at + 1);
  const next = rest.search(/^m=/m);
  const section = next < 0 ? rest : rest.slice(0, next);
  const m = section.match(/^a=(sendrecv|sendonly|recvonly|inactive)\s*$/m);
  return m ? m[1] : "sendrecv"; // RFC 4566: sendrecv when absent
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

export function initCalls(core, { rtcpFactory, getUserMedia, notify, audioRoute, log } = {}) {
  const mgr = new CallManager(core, rtcpFactory, getUserMedia, notify, audioRoute, log);
  mgr.bind();
  return mgr;
}

export class CallManager extends EventTarget {
  constructor(core, rtcpFactory, getUserMedia, notify, audioRoute, log) {
    super();
    this.core = core;
    this._rtcpFactory = rtcpFactory || ((cfg) => new RTCPeerConnection(cfg));
    this._getUserMedia = getUserMedia || ((c) => navigator.mediaDevices.getUserMedia(c));
    this._notify = notify || (() => {});
    this._route = audioRoute || shellAudioRoute();
    this._log = log || callDebugLog;
    this._routeOps = Promise.resolve(); // shell route calls run in order
    this.reset();
  }

  reset() {
    this.state = "idle"; // idle|incoming|outgoing|active|ended
    this.callMsgId = null;
    this.chatId = null;
    this.chatName = "";
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.muted = false;
    this.speaker = false; // loudspeaker on (Android route); false = earpiece/headset
    this.route = ""; // what the shell reported: earpiece|speaker|wired|bluetooth|usb|…
    this.routeActive = false;
    this.hasVideo = false;
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

  /* ---------------- outgoing ---------------- */

  async startOutgoing(chatId, chatName) {
    if (this.state !== "idle") return false;
    this.state = "outgoing";
    this.chatId = chatId;
    this.chatName = chatName;
    this.hasVideo = false;
    this.speaker = defaultSpeakerOn(false);
    this.render("Calling…", ["hangup"]);
    try {
      this.localStream = await this.openMic();
    } catch (err) {
      this._log(`getUserMedia failed: ${err?.name || ""} ${err?.message || err}`);
      this._notify("Microphone unavailable: " + (err?.message || err));
      this.finish("Mic unavailable");
      return false;
    }
    wakeLockAcquire(); // the screen must not sleep mid-call
    this.startRoute();
    this.render("Calling…", this.controls());
    try {
      const cfg = { iceServers: await this.safeIceServers() };
      this.pc = this._rtcpFactory(cfg);
      this.attachMedia();
      this.addLocalTracks(); // before createOffer, or the offer is recvonly
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await gatherComplete(this.pc);
      const sdp = this.pc.localDescription.sdp;
      this._log(`offer audio=${sdpAudioDirection(sdp)}`);
      this.callMsgId = Number(await this.core.placeOutgoingCall(chatId, sdp, false));
      this.render("Ringing…", this.controls());
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
    this.callMsgId = Number(d.msgId);
    this.chatId = Number(d.chatId);
    let name = "";
    try { name = (await this.core.getChat(this.chatId))?.name || ""; } catch {}
    this.chatName = name || "Incoming call";
    this.hasVideo = !!d.hasVideo;
    this.render("Incoming call…", ["accept", "decline"]);
    this._notify(`Incoming call — ${this.chatName}`);
  }

  async acceptIncoming() {
    if (this.state !== "incoming") return;
    const msgId = this.callMsgId;
    this.speaker = defaultSpeakerOn(false); // we answer audio-only
    this.render("Connecting…", ["hangup"]);
    try {
      this.localStream = await this.openMic();
      wakeLockAcquire(); // the screen must not sleep mid-call
      this.startRoute();
      const info = await this.core.callInfo(msgId);
      const cfg = { iceServers: await this.safeIceServers() };
      this.pc = this._rtcpFactory(cfg);
      this.attachMedia();
      this._log(`remote offer audio=${sdpAudioDirection(info.sdpOffer)} hasVideo=${!!info.hasVideo}`);
      await this.pc.setRemoteDescription({ type: "offer", sdp: info.sdpOffer });
      // After the remote offer, so addTrack reuses the offer's audio
      // transceiver (the Delta Chat calls webapp does the same); before
      // createAnswer, or the answer is recvonly and the peer hears nothing.
      this.addLocalTracks();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await gatherComplete(this.pc);
      const sdp = this.pc.localDescription.sdp;
      this._log(`answer audio=${sdpAudioDirection(sdp)}`);
      await this.core.acceptIncomingCall(msgId, sdp);
      this.state = "active";
      this.startTimer();
      this.render("Connected", this.controls());
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
      this._log(`remote answer audio=${sdpAudioDirection(d.acceptCallInfo)}`);
      await this.pc.setRemoteDescription({ type: "answer", sdp: d.acceptCallInfo });
      this.state = "active";
      this.startTimer();
      this.render("Connected", this.controls());
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

  // Buttons for the current state: mute once connected, the speaker toggle
  // while a call is up (ringing included) and the shell can route audio.
  controls() {
    const out = [];
    if (this.state === "active") out.push("mute");
    if ((this.state === "active" || this.state === "outgoing") && this._route?.supported) out.push("speaker");
    out.push("hangup");
    return out;
  }

  statusText() {
    return this.state === "active" ? "Connected" : this.callMsgId ? "Ringing…" : "Calling…";
  }

  toggleMute() {
    if (!this.localStream) return this.muted;
    this.muted = !this.muted;
    for (const t of this.localStream.getAudioTracks()) t.enabled = !this.muted;
    this._log(`mute=${this.muted}`);
    this.render(this.statusText(), this.controls());
    return this.muted;
  }

  // Earpiece <-> loudspeaker (Android). Optimistic: the button flips at once;
  // the shell's answer (the actual route, e.g. "wired") lands in this.route.
  async toggleSpeaker() {
    if (!this._route?.supported || this.state === "idle" || this.state === "ended") return this.speaker;
    this.speaker = !this.speaker;
    this.render(this.statusText(), this.controls());
    try {
      const on = this.speaker;
      this.route = String((await this.queueRoute(() => this._route.setSpeaker(on))) || "");
      this._log(`speaker=${this.speaker} route=${this.route}`);
    } catch (err) {
      this._log(`setSpeaker failed: ${err?.message || err}`);
      this._notify("Couldn't switch the speaker: " + (err?.message || err));
    }
    return this.speaker;
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

  // #141 root cause: without this the mic was opened but never sent.
  addLocalTracks() {
    const tracks = this.localStream?.getAudioTracks?.() || [];
    for (const t of tracks) {
      t.enabled = !this.muted;
      this.pc.addTrack(t, this.localStream);
    }
    const senders = this.pc.getSenders?.() || [];
    this._log(`addTrack: ${tracks.length} audio track(s), ${senders.filter((s) => s.track).length} sender(s) with a track`);
  }

  // Android: MODE_IN_COMMUNICATION + earpiece (or the headset) by default.
  // Called after getUserMedia: the WebView switches the audio mode when the
  // capture starts (to the loudspeaker), so ours must come later to win.
  startRoute() {
    if (!this._route?.supported) return;
    this.routeActive = true;
    this.queueRoute(() => this._route.start(this.speaker))
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
    this.queueRoute(() => this._route.setSpeaker(this.speaker))
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
      if (st === "connected") this.reapplyRoute("connected");
      if (this.pc && st === "failed") {
        this._notify("Call connection failed");
        this.teardown(true);
      }
    });
    this.pc.addEventListener?.("iceconnectionstatechange", () => this._log(`ice=${this.pc?.iceConnectionState}`));
    if (typeof MediaStream === "undefined") return; // headless (tests)
    this.remoteStream = new MediaStream();
    this.pc.addEventListener("track", (e) => {
      // A peer that adds a track without a stream leaves e.streams empty.
      const tracks = e.streams?.[0]?.getAudioTracks?.() || (e.track?.kind === "audio" ? [e.track] : []);
      for (const t of tracks) {
        if (!this.remoteStream.getTrackById(t.id)) this.remoteStream.addTrack(t);
      }
      this._log(`remote track kind=${e.track?.kind} muted=${e.track?.muted} streams=${e.streams?.length || 0}`);
      this.playRemote();
    });
    this.playRemote();
  }

  playRemote() {
    if (!this.remoteStream || typeof document === "undefined") return;
    let audio = document.getElementById("call-remote-audio");
    if (!audio) {
      audio = document.createElement("audio");
      audio.id = "call-remote-audio";
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    // Re-assigning the same stream restarts the load and rejects the
    // pending play() ("interrupted by a new load request").
    if (audio.srcObject !== this.remoteStream) audio.srcObject = this.remoteStream;
    audio.play().catch((err) => this._log(`remote audio play() failed: ${err?.message || err}`));
  }

  async safeIceServers() {
    try {
      const servers = await this.core.iceServers();
      return Array.isArray(servers) ? servers.filter((s) => s && s.urls) : [];
    } catch {
      return [];
    }
  }

  startTimer() {
    this.connectedAt = Date.now();
    const tick = () => {
      if (this.state !== "active" || typeof document === "undefined") return;
      const s = Math.floor((Date.now() - this.connectedAt) / 1000);
      const el = document.querySelector("#call-overlay .call-timer");
      if (el) el.textContent = formatDuration(s);
    };
    tick();
    this.durationTimer = setInterval(tick, 1000);
  }

  // Final transition: brief "ended" display, then full teardown.
  finish(label) {
    const wasActive = this.state === "active";
    const seconds = wasActive && this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1000) : 0;
    this.state = "ended";
    this.render(label + (wasActive && seconds ? ` · ${formatDuration(seconds)}` : ""), []);
    setTimeout(() => {
      this.releaseMedia();
      this.state = "idle";
      this.hideOverlay();
    }, this.endedVisibleMs);
  }

  // Immediate teardown (decline, hangup, account switch): no ended display.
  teardown(silent) {
    if (this.state === "idle") return;
    try { if (this.durationTimer) clearInterval(this.durationTimer); } catch {}
    try { if (this.pc) this.pc.close(); } catch {}
    try { for (const t of this.localStream?.getTracks() || []) t.stop(); } catch {}
    if (typeof document !== "undefined") {
      const audio = document.getElementById("call-remote-audio");
      if (audio) { audio.srcObject = null; audio.remove(); }
    }
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
    this.stopRoute();
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.connectedAt = 0;
    this.callMsgId = null;
  }

  hideOverlay() {
    if (typeof document === "undefined") return;
    document.getElementById("call-overlay")?.remove();
  }

  /* ---------------- overlay UI ---------------- */

  render(status, actions) {
    if (typeof document === "undefined") return; // headless (tests)
    let box = document.getElementById("call-overlay");
    if (!box) {
      box = document.createElement("div");
      box.id = "call-overlay";
      document.body.appendChild(box);
    }
    // Re-rendering replaces the buttons: keep keyboard focus on the same one.
    const focused = box.contains(document.activeElement) ? document.activeElement?.dataset?.call : null;
    const timer = this.state === "active" ? `<div class="call-timer">${this.connectedAt ? formatDuration(Math.floor((Date.now() - this.connectedAt) / 1000)) : "00:00"}</div>` : "";
    box.innerHTML = `
      <div class="call-box">
        <div class="call-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .57 3.6 1 1 0 0 1-.25 1z" fill="currentColor"/></svg>
        </div>
        <div class="call-name"></div>
        <div class="call-status" role="status"></div>
        ${timer}
        <div class="call-actions">${callButtonsHtml(actions, { muted: this.muted, speaker: this.speaker })}</div>
      </div>`;
    box.querySelector(".call-name").textContent = this.chatName || "Call";
    box.querySelector(".call-status").textContent = status;
    box.querySelector('[data-call="hangup"]')?.addEventListener("click", () => this.hangUp());
    box.querySelector('[data-call="accept"]')?.addEventListener("click", () => this.acceptIncoming());
    box.querySelector('[data-call="decline"]')?.addEventListener("click", () => this.declineIncoming());
    box.querySelector('[data-call="mute"]')?.addEventListener("click", () => this.toggleMute());
    box.querySelector('[data-call="speaker"]')?.addEventListener("click", () => this.toggleSpeaker());
    if (focused) box.querySelector(`[data-call="${focused}"]`)?.focus();
  }
}

// Loudspeaker icon (speaker cone + two waves) in the call-overlay style:
// currentColor, 24-unit viewBox like the phone glyph above.
const SPEAKER_ICON = `<svg class="call-btn-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

// Overlay buttons, as markup. Pure (node-testable). The speaker button is a
// toggle: fixed label, state in aria-pressed (and the .on class for styling).
export function callButtonsHtml(actions, { muted = false, speaker = false } = {}) {
  const btn = {
    mute: `<button type="button" data-call="mute" class="call-btn${muted ? " muted" : ""}">${muted ? "Unmute" : "Mute"}</button>`,
    speaker: `<button type="button" data-call="speaker" class="call-btn call-speaker${speaker ? " on" : ""}" aria-pressed="${speaker ? "true" : "false"}" title="${speaker ? "Loudspeaker on — tap for the earpiece" : "Earpiece — tap for the loudspeaker"}">${SPEAKER_ICON}<span>Speaker</span></button>`,
    hangup: `<button type="button" data-call="hangup" class="call-btn danger">End call</button>`,
    accept: `<button type="button" data-call="accept" class="call-btn accept">Accept</button>`,
    decline: `<button type="button" data-call="decline" class="call-btn danger">Decline</button>`,
  };
  return (actions || []).map((a) => btn[a] || "").join("");
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
