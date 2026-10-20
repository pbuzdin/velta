// group-call-card.js — the group call message as a card in the chat
// (docs/agents/group-calls.md): the creator's avatar, the call name, who is
// in the call (live, from the instance's status updates), and Join /
// "You're in" + Leave / an ended state. No ringing: the card is the invite.
// Only rendered for a TRUSTED bundle (xdc-trust.js); in Delta Chat the same
// message stays a plain webxdc card whose app shows "needs Velta".
import { GroupCallSignal, callMeta } from "./group-call-signal.js";
import { nameColor } from "./name-color.js";

export const CARD_REFRESH_MS = 20000; // members expire by TTL, re-evaluate
export const CARD_AVATARS = 5;

export function initialOf(n) { return (String(n || "?").trim()[0] || "?").toUpperCase(); }

/**
 * Card state from the instance's status updates and the live call.
 * live: the host's snapshot when WE are in this call (else null).
 * -> {title, creatorName, members:[{id,name}], count, joined, ended, started}
 */
export function cardModel(updates, { now = Date.now(), live = null } = {}) {
  const meta = callMeta(updates);
  const sig = new GroupCallSignal({ selfId: "\u0000card", sid: "card", statusOnly: true, now: () => now, sendUpdate: async () => {} });
  sig.ingestUpdates(updates);
  let members = sig.roster().filter((m) => m.id !== "\u0000card").map((m) => ({ id: m.id, name: m.name }));
  const started = (updates || []).some((u) => u?.payload?.veltaCall?.t === "join");
  const joined = !!live && live.state !== "ended";
  if (joined) {
    // Our own view is fresher than the status updates: use the live roster.
    members = (live.participants || []).map((p) => ({ id: p.id, name: p.name || "" }));
  }
  return { title: meta.title, creatorName: meta.creatorName, members, count: members.length, joined,
    ended: started && !joined && members.length === 0, started };
}

export function subText(model, creator) {
  const by = creator ? `Started by ${creator}` : "";
  if (model.ended) return [by, "Call ended"].filter(Boolean).join(" · ");
  if (model.count === 0) return [by, "Nobody in the call yet"].filter(Boolean).join(" · ");
  return [by, `${model.count} in call`].filter(Boolean).join(" · ");
}

/** Fill the card's dynamic parts (title, sub line, avatars, buttons). */
export function renderCard(el, model, { creatorName = "" } = {}) {
  const creator = creatorName || model.creatorName;
  el.classList.toggle("gc-joined", model.joined);
  el.classList.toggle("gc-ended", model.ended);
  el.querySelector(".gc-title").textContent = model.title;
  el.querySelector(".gc-sub").textContent = subText(model, creator);
  const row = el.querySelector(".gc-people");
  row.textContent = "";
  for (const m of model.members.slice(0, CARD_AVATARS)) {
    // The existing avatar component; roster ids are per-app pseudonyms (no
    // contact photo/color), so the shared name-derived color.
    const a = el.ownerDocument.createElement("velta-avatar");
    a.className = "gc-mini"; a.setAttribute("name", m.name || m.id); a.setAttribute("color", nameColor(m.name || m.id)); a.setAttribute("size", "24");
    a.title = m.name || ""; row.appendChild(a);
  }
  if (model.members.length > CARD_AVATARS) {
    const more = el.ownerDocument.createElement("span");
    more.className = "gc-more"; more.textContent = `+${model.members.length - CARD_AVATARS}`; row.appendChild(more);
  }
  row.hidden = model.members.length === 0;
  row.setAttribute("aria-label", model.members.map((m) => m.name).filter(Boolean).join(", "));
  const join = el.querySelector(".gc-join"), inn = el.querySelector(".gc-in"), leave = el.querySelector(".gc-leave"), ended = el.querySelector(".gc-ended-label");
  join.hidden = model.joined || model.ended;
  inn.hidden = !model.joined; leave.hidden = !model.joined;
  ended.hidden = !model.ended;
  // An ended call can be restarted from the same card (same room).
  if (model.ended) { join.hidden = false; join.textContent = "Start again"; } else join.textContent = "Join";
}

/** Card markup (static part; the creator avatar is a <velta-avatar>). */
export function cardHtml({ msgId, avatarHtml, esc }) {
  return `<div class="msg-groupcall" data-gc="${Number(msgId)}" role="group" aria-label="Group call">
  <div class="gc-head">${avatarHtml}<div class="gc-text"><div class="gc-title">${esc("Group call")}</div><div class="gc-sub">Loading…</div></div></div>
  <div class="gc-people" hidden></div>
  <div class="gc-actions">
    <button type="button" class="gc-join btn-text gc-primary">Join</button>
    <span class="gc-in" hidden>✓ You're in</span>
    <button type="button" class="gc-open btn-text" title="Open the call screen">Open</button>
    <button type="button" class="gc-leave btn-text" hidden>Leave</button>
    <span class="gc-ended-label" hidden>Ended</span>
  </div>
</div>`;
}

/**
 * Keep a card live. deps: {core, msgId, creatorName, alive(), live(), onCallChange(cb)->unsub,
 * join(), leave(), open(), now?, setInterval?, clearInterval?}
 */
export function wireCard(el, deps) {
  const now = deps.now || (() => Date.now());
  let updates = [];
  let serial = 0;
  let stopped = false;
  const draw = () => {
    // Off-screen (another chat, a detached cached row): skip, keep listening —
    // the virtual scroller may re-attach this very node later.
    if (stopped || !deps.alive()) return;
    renderCard(el, cardModel(updates, { now: now(), live: deps.live() }), { creatorName: deps.creatorName });
  };
  const pull = async () => {
    try {
      const rows = JSON.parse(await deps.core.getWebxdcStatusUpdates(deps.msgId, serial)) || [];
      for (const r of rows) serial = Math.max(serial, r.serial || 0);
      updates = updates.concat(rows);
    } catch {}
    draw();
  };
  const onUpd = (e) => { if (Number(e?.detail?.msgId) === Number(deps.msgId)) pull(); };
  deps.core.addEventListener?.("webxdc-status-update", onUpd);
  const unsub = deps.onCallChange?.(() => draw());
  const t = (deps.setInterval || setInterval)(draw, CARD_REFRESH_MS);
  function stop() {
    if (stopped) return; stopped = true;
    deps.core.removeEventListener?.("webxdc-status-update", onUpd);
    unsub?.(); (deps.clearInterval || clearInterval)(t);
  }
  const busy = async (btn, f) => { btn.disabled = true; try { await f(); } catch {} finally { btn.disabled = false; draw(); } };
  el.querySelector(".gc-join").addEventListener("click", (e) => { e.stopPropagation(); busy(e.currentTarget, deps.join); });
  el.querySelector(".gc-leave").addEventListener("click", (e) => { e.stopPropagation(); busy(e.currentTarget, deps.leave); });
  el.querySelector(".gc-open").addEventListener("click", (e) => { e.stopPropagation(); deps.open(); });
  pull();
  return { refresh: pull, stop, _model: () => cardModel(updates, { now: now(), live: deps.live() }) };
}
