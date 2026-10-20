// group-call-ui.js — the host chrome for a live group call (Phase 3,
// docs/agents/group-calls.md): consent prompt, the in-call bar that
// survives chat switches and app close (mute / open / leave), and the
// platform env (Android audio route, wake lock) for GroupCallSession.
// KEEP: the "Velta group call" label and the controls live HERE, outside
// the app iframe — an app can draw anything, so trust is never shown inside it.
import { onGroupCallChange, leaveGroupCall, setGroupCallMuted, currentGroupCall } from "./group-call-host.js";
import { confirmModal, toast } from "./ui.js";
import { wakeLockAcquire, wakeLockRelease } from "./wakelock.js";
import { invoke, isAndroid, isTauri } from "./tauri.js";

export const CONSENT_TITLE = "Join the group call?";
export const CONSENT_TEXT = "Velta will use your microphone for this call. Audio is relayed through TURN servers (turn.delta.chat), so other participants don't see your IP address.";

export function askGroupCallConsent(chatName) {
  return confirmModal(CONSENT_TITLE + (chatName ? ` — ${chatName}` : ""), CONSENT_TEXT, "Join", false);
}

/** Platform env for GroupCallSession. */
export function groupCallEnv({ log } = {}) {
  const android = isTauri() && isAndroid();
  return {
    log,
    audioRoute: android ? {
      start: (speaker) => invoke("call_audio_start", { speaker: !!speaker, auto: true }),
      stop: () => invoke("call_audio_stop"),
    } : null,
    wakeLock: { acquire: wakeLockAcquire, release: wakeLockRelease },
  };
}

/** A 1:1 call is on screen (calls.js overlay): no group call on top of it. */
export function oneToOneCallActive() {
  return !!document.getElementById("call-overlay");
}

let bar = null;
let openApp = null;

function ensureBar() {
  if (bar) return bar;
  bar = document.createElement("div");
  bar.id = "group-call-bar";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Group call");
  bar.innerHTML = `<button type="button" class="gcb-open" title="Open the call"><span class="gcb-dot" aria-hidden="true"></span><span class="gcb-text"></span></button>
<button type="button" class="gcb-mute" aria-pressed="false">Mute</button>
<button type="button" class="gcb-leave">Leave</button>`;
  bar.querySelector(".gcb-mute").addEventListener("click", () => {
    const s = currentGroupCall()?.snapshot();
    if (s) setGroupCallMuted(!s.muted);
  });
  bar.querySelector(".gcb-leave").addEventListener("click", () => leaveGroupCall().catch(() => {}));
  bar.querySelector(".gcb-open").addEventListener("click", () => {
    const s = currentGroupCall();
    if (!s) return;
    window.dispatchEvent(new CustomEvent("velta-open-chat", { detail: { chatId: s.chatId } }));
    openApp?.(s.msgId);
  });
  document.body.appendChild(bar);
  return bar;
}

export function renderBar(s) {
  if (!s || s.state === "ended" || s.state === "idle") {
    bar?.remove(); bar = null;
    document.documentElement.classList.remove("in-group-call");
    if (s?.state === "ended" && s.error) toast("Group call: " + s.error, 4000);
    return;
  }
  const b = ensureBar();
  document.documentElement.classList.add("in-group-call");
  const n = s.participants?.length || 1;
  const who = s.activeSpeaker && s.activeSpeaker !== s.participants?.find((p) => p.self)?.id
    ? (s.participants.find((p) => p.id === s.activeSpeaker)?.name || "") : "";
  const label = s.state === "joining" ? "Connecting…" : s.state === "full" ? "Call is full — waiting" :
    `Velta group call${s.chatName ? " · " + s.chatName : ""} · ${n}${who ? " · " + who + " speaking" : ""}`;
  b.querySelector(".gcb-text").textContent = label;
  b.classList.toggle("speaking", !!s.activeSpeaker);
  const m = b.querySelector(".gcb-mute");
  m.setAttribute("aria-pressed", String(!!s.muted));
  m.textContent = s.muted ? "Unmute" : "Mute";
}

/** Wire once from app.js; `open(msgId)` opens the call app (webxdc-manager). */
export function initGroupCallUi({ open } = {}) {
  openApp = open || null;
  onGroupCallChange((s) => renderBar(s));
  window.addEventListener("beforeunload", () => { if (currentGroupCall()) leaveGroupCall().catch(() => {}); });
}
