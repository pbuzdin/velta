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
// Everything platform-shaped (RTCPeerConnection, getUserMedia, timers) is
// injected so the state machine can be exercised in tests.

const GATHER_TIMEOUT = 3000; // ICE gathering ceiling before sending anyway
const ENDED_VISIBLE_MS = 2500; // how long the ended overlay stays readable

export function initCalls(core, { rtcpFactory, getUserMedia, notify } = {}) {
  const mgr = new CallManager(core, rtcpFactory, getUserMedia, notify);
  mgr.bind();
  return mgr;
}

export class CallManager extends EventTarget {
  constructor(core, rtcpFactory, getUserMedia, notify) {
    super();
    this.core = core;
    this._rtcpFactory = rtcpFactory || ((cfg) => new RTCPeerConnection(cfg));
    this._getUserMedia = getUserMedia || ((c) => navigator.mediaDevices.getUserMedia(c));
    this._notify = notify || (() => {});
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
    this.render("Calling…", ["hangup"]);
    try {
      this.localStream = await this._getUserMedia({ audio: true });
    } catch (err) {
      this._notify("Microphone unavailable: " + (err?.message || err));
      this.finish("Mic unavailable");
      return false;
    }
    try {
      const cfg = { iceServers: await this.safeIceServers() };
      this.pc = this._rtcpFactory(cfg);
      this.attachMedia();
      const offer = await this.pc.createOffer({ offerToReceiveAudio: true });
      await this.pc.setLocalDescription(offer);
      await gatherComplete(this.pc);
      this.callMsgId = Number(await this.core.placeOutgoingCall(chatId, this.pc.localDescription.sdp, false));
      this.render("Ringing…", ["hangup"]);
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
    this.render("Connecting…", ["hangup"]);
    try {
      this.localStream = await this._getUserMedia({ audio: true });
      const info = await this.core.callInfo(msgId);
      const cfg = { iceServers: await this.safeIceServers() };
      this.pc = this._rtcpFactory(cfg);
      this.attachMedia();
      await this.pc.setRemoteDescription({ type: "offer", sdp: info.sdpOffer });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await gatherComplete(this.pc);
      await this.core.acceptIncomingCall(msgId, this.pc.localDescription.sdp);
      this.state = "active";
      this.startTimer();
      this.render("Connected", ["mute", "hangup"]);
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
      await this.pc.setRemoteDescription({ type: "answer", sdp: d.acceptCallInfo });
      this.state = "active";
      this.startTimer();
      this.render("Connected", ["mute", "hangup"]);
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

  toggleMute() {
    if (!this.localStream) return this.muted;
    this.muted = !this.muted;
    for (const t of this.localStream.getAudioTracks()) t.enabled = !this.muted;
    this.render(this.state === "active" ? "Connected" : "Calling…", ["mute", "hangup"]);
    return this.muted;
  }

  hangUp() {
    if (this.callMsgId) {
      this.core.endCall(this.callMsgId).catch(() => {});
    }
    this.teardown(true);
  }

  /* ---------------- internals ---------------- */

  attachMedia() {
    if (typeof MediaStream === "undefined") return; // headless (tests)
    this.remoteStream = new MediaStream();
    this.pc.addEventListener("track", (e) => {
      for (const t of e.streams[0]?.getAudioTracks() || []) this.remoteStream.addTrack(t);
      this.playRemote();
    });
    this.pc.addEventListener("connectionstatechange", () => {
      if (this.pc && this.pc.connectionState === "failed") {
        this._notify("Call connection failed");
        this.teardown(true);
      }
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
    audio.srcObject = this.remoteStream;
    audio.play().catch(() => {});
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
      const mm = String(Math.floor(s / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      const el = document.querySelector("#call-overlay .call-timer");
      if (el) el.textContent = `${mm}:${ss}`;
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
    if (this.durationTimer) { clearInterval(this.durationTimer); this.durationTimer = null; }
    try { if (this.pc) this.pc.close(); } catch {}
    try { for (const t of this.localStream?.getTracks() || []) t.stop(); } catch {}
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
    const mutedNow = this.muted;
    const btn = {
      mute: `<button type="button" data-call="mute" class="call-btn${mutedNow ? " muted" : ""}">${mutedNow ? "Unmute" : "Mute"}</button>`,
      hangup: `<button type="button" data-call="hangup" class="call-btn danger">End call</button>`,
      accept: `<button type="button" data-call="accept" class="call-btn accept">Accept</button>`,
      decline: `<button type="button" data-call="decline" class="call-btn danger">Decline</button>`,
    };
    const timer = this.state === "active" ? `<div class="call-timer">00:00</div>` : "";
    const actionsHtml = actions.map((a) => btn[a] || "").join("");
    box.innerHTML = `
      <div class="call-box">
        <div class="call-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .57 3.6 1 1 0 0 1-.25 1z" fill="currentColor"/></svg>
        </div>
        <div class="call-name"></div>
        <div class="call-status"></div>
        ${timer}
        <div class="call-actions">${actionsHtml}</div>
      </div>`;
    box.querySelector(".call-name").textContent = this.chatName || "Call";
    box.querySelector(".call-status").textContent = status;
    box.querySelector('[data-call="hangup"]')?.addEventListener("click", () => this.hangUp());
    box.querySelector('[data-call="accept"]')?.addEventListener("click", () => this.acceptIncoming());
    box.querySelector('[data-call="decline"]')?.addEventListener("click", () => this.declineIncoming());
    box.querySelector('[data-call="mute"]')?.addEventListener("click", () => this.toggleMute());
  }
}

export function formatDuration(seconds) {
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
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
