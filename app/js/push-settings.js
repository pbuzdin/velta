// #140: Settings → Push notifications (Android only). A native
// <details class="drawer-details"> section in the drawer, like the other
// settings groups. State comes from the shell (push_status → Kotlin
// UnifiedPushBridge): installed UnifiedPush distributors with app labels,
// the saved one, an explicit Off, and the last push time recorded by
// UnifiedPushService. Relay support reuses relay-push.js (#110 "(U)" data).

import { relaySupportsPush } from "./relay-push.js";
import { escapeHtml } from "./format.js";
import { t } from "./i18n.js";

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
  if (!s.distributors.length) return t("No push app installed — using periodic background checks");
  if (s.saved) {
    const d = s.distributors.find(x => x.pkg === s.saved);
    return t("Using {app}", { app: d ? d.label : (s.savedLabel || s.saved) });
  }
  if (s.optedOut) return t("Off — using periodic background checks");
  return t("Off — pick a push app below");
}

/** Relay support line from the relay-push.js cache. */
export function describeRelaySupport(addrs, storage = globalThis.localStorage) {
  const list = (addrs || []).filter(Boolean);
  if (!list.length) return t("Relay push support: unknown");
  const ok = list.filter(a => relaySupportsPush(a, storage)).length;
  if (ok === list.length) return list.length === 1 ? t("Your relay supports push") : t("All your relays support push");
  if (ok === 0) return t("Relay push support not confirmed yet (needs a registered push app)");
  return t("{n} of {total} relays support push", { n: ok, total: list.length });
}

export function describeLastPush(ts, now = Date.now()) {
  if (!ts) return t("No push received yet");
  const d = new Date(ts);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return t("Last push: {when}", { when: sameDay ? hm : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + hm });
}

const esc = escapeHtml;

/** Inner HTML of the section body. */
export function pushBodyHtml(s, { relayLine = "" } = {}) {
  const sel = selectedValue(s);
  const opts = s.distributors.map(d => [d.pkg, d.label]);
  if (opts.length) opts.push([OFF_VALUE, t("Off")]);
  return `
    <div class="bar-opts-hint" data-push-state role="status" aria-live="polite">${esc(describePushState(s))}</div>
    ${opts.length ? `<fieldset class="scale-opts" data-push-opts>
      <legend class="vh">${escapeHtml(t("Push app"))}</legend>
      ${opts.map(([v, label]) => `<label class="scale-opt"><input type="radio" name="push-distributor" value="${esc(v)}"${v === sel ? " checked" : ""}><span>${esc(label)}</span></label>`).join("")}
    </fieldset>` : `<div class="bar-opts-hint"><a href="${PUSH_APP_URL}" data-push-get rel="noopener" target="_blank">${escapeHtml(t("Get a push app (ntfy)"))}</a> — ${escapeHtml(t("install one for instant delivery."))}</div>`}
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
    catch (e) { body.innerHTML = `<div class="bar-opts-hint">${escapeHtml(t("Push status unavailable:"))} ${esc(e?.message || e)}</div>`; return; }
    let addrs = [];
    try { addrs = (await getRelayAddrs?.()) || []; } catch { /* offline */ }
    body.innerHTML = pushBodyHtml(s, { relayLine: describeRelaySupport(addrs) });
    if (summary) summary.textContent = t("{label}: {state}", { label: t("Push notifications"), state: t(s.saved ? "on" : "off") });
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
      if (input.value === OFF_VALUE) { await invoke("push_off"); toast?.(t("Push notifications off")); }
      else { await invoke("push_select", { package: input.value }); toast?.(t("Push app selected")); }
    } catch (err) {
      errToast?.(t("Couldn't change the push app: ") + (err?.message || err));
    }
    paint();
  });
}
