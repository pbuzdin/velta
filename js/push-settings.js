// #140: Settings → Push notifications (Android only). A native
// <details class="drawer-details"> section in the drawer, like the other
// settings groups. State comes from the shell (push_status → Kotlin
// UnifiedPushBridge): installed UnifiedPush distributors with app labels,
// the saved one, an explicit Off, and the last push time recorded by
// UnifiedPushService. Relay support reuses relay-push.js (#110 "(U)" data).

import { relaySupportsPush } from "./relay-push.js";
import { escapeHtml } from "./format.js";

export const PUSH_APP_URL = "https://ntfy.sh/";
export const OFF_VALUE = "__off__";

/** Normalize the shell's JSON (string or object) into a safe shape. */
export function parsePushStatus(raw) {
  let v = raw;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
  if (!v || typeof v !== "object") v = {};
  const distributors = (Array.isArray(v.distributors) ? v.distributors : [])
    .filter(d => d && typeof d.pkg === "string" && d.pkg)
    .map(d => ({ pkg: d.pkg, label: String(d.label || d.pkg) }));
  return {
    distributors,
    saved: typeof v.saved === "string" ? v.saved : "",
    savedLabel: String(v.savedLabel || ""),
    optedOut: v.optedOut === true,
    lastPush: Number(v.lastPush) > 0 ? Number(v.lastPush) : 0,
  };
}

/** Which picker value is selected: a package, OFF_VALUE, or "" (none). */
export function selectedValue(s) {
  if (!s.distributors.length) return "";
  return s.saved || OFF_VALUE;
}

/** One-line current state for the summary. */
export function describePushState(s) {
  if (!s.distributors.length) return "No push app installed — using periodic background checks";
  if (s.saved) {
    const d = s.distributors.find(x => x.pkg === s.saved);
    return `Using ${d ? d.label : (s.savedLabel || s.saved)}`;
  }
  if (s.optedOut) return "Off — using periodic background checks";
  return "Off — pick a push app below";
}

/** Relay support line from the relay-push.js cache. */
export function describeRelaySupport(addrs, storage = globalThis.localStorage) {
  const list = (addrs || []).filter(Boolean);
  if (!list.length) return "Relay push support: unknown";
  const ok = list.filter(a => relaySupportsPush(a, storage)).length;
  if (ok === list.length) return list.length === 1 ? "Your relay supports push" : "All your relays support push";
  if (ok === 0) return "Relay push support not confirmed yet (needs a registered push app)";
  return `${ok} of ${list.length} relays support push`;
}

export function describeLastPush(ts, now = Date.now()) {
  if (!ts) return "No push received yet";
  const d = new Date(ts);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Last push: ${sameDay ? t : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t}`;
}

const esc = escapeHtml;

/** Inner HTML of the section body. */
export function pushBodyHtml(s, { relayLine = "" } = {}) {
  const sel = selectedValue(s);
  const opts = s.distributors.map(d => [d.pkg, d.label]);
  if (opts.length) opts.push([OFF_VALUE, "Off"]);
  return `
    <div class="bar-opts-hint" data-push-state role="status" aria-live="polite">${esc(describePushState(s))}</div>
    ${opts.length ? `<fieldset class="scale-opts" data-push-opts>
      <legend class="vh">Push app</legend>
      ${opts.map(([v, label]) => `<label class="scale-opt"><input type="radio" name="push-distributor" value="${esc(v)}"${v === sel ? " checked" : ""}><span>${esc(label)}</span></label>`).join("")}
    </fieldset>` : `<div class="bar-opts-hint"><a href="${PUSH_APP_URL}" data-push-get rel="noopener" target="_blank">Get a push app (ntfy)</a> — install one for instant delivery.</div>`}
    <div class="bar-opts-hint" data-push-relay>${esc(relayLine)}</div>
    <div class="bar-opts-hint" data-push-last>${esc(describeLastPush(s.lastPush))}</div>`;
}

/**
 * Wire the drawer section: fill on first open (and every reopen), handle
 * picks. `getRelayAddrs` returns the current account's relay addresses.
 */
export function wirePushSection(details, { invoke, getRelayAddrs, openUrl, toast, errToast }) {
  if (!details || !invoke) return;
  const body = details.querySelector("[data-push-body]");
  const summary = details.querySelector("[data-push-summary]");
  const paint = async () => {
    let s;
    try { s = parsePushStatus(await invoke("push_status")); }
    catch (e) { body.innerHTML = `<div class="bar-opts-hint">Push status unavailable: ${esc(e?.message || e)}</div>`; return; }
    let addrs = [];
    try { addrs = (await getRelayAddrs?.()) || []; } catch { /* offline */ }
    body.innerHTML = pushBodyHtml(s, { relayLine: describeRelaySupport(addrs) });
    if (summary) summary.textContent = `Push notifications: ${s.saved ? "on" : "off"}`;
  };
  details.addEventListener("toggle", () => { if (details.open) paint(); });
  body.addEventListener("click", e => {
    const a = e.target.closest?.("[data-push-get]");
    if (!a) return;
    e.preventDefault();
    openUrl?.(a.href);
  });
  body.addEventListener("change", async e => {
    const input = e.target;
    if (input?.name !== "push-distributor") return;
    try {
      if (input.value === OFF_VALUE) { await invoke("push_off"); toast?.("Push notifications off"); }
      else { await invoke("push_select", { package: input.value }); toast?.("Push app selected"); }
    } catch (err) {
      errToast?.("Couldn't change the push app: " + (err?.message || err));
    }
    paint();
  });
}
