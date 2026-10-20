// Web Push for the wasm PWA (docs/agents/web-push.md). The browser's push
// service delivers a ping from the chatmail notifier (notifications.delta.chat)
// while no Velta tab runs; the service worker (scripts/build-pwa.mjs) shows a
// generic "New message" notification. The core never sees the ping — mail is
// fetched when the user opens the app.
//
// Flow: Notification permission → pushManager.subscribe(applicationServerKey =
// VAPID_KEY) → token "webpush:<endpoint>|<p256dh>|<auth>" → wasm
// set_push_device_token (shared by every account; each account's IMAP loop
// encrypts it for the notifier and stores it in METADATA when its relay
// advertises XDELTAPUSH). The core keeps the token in memory only, so the
// page hands it over again on every boot (refreshWebPush).
//
// Pure helpers are node-tested (tests/web-push.test.mjs).

import { escapeHtml } from "./format.js";

// VAPID public key of the chatmail notifier. Same constant as
// UnifiedPushService.kt (Android UnifiedPush) and ArcaneChat's build.gradle.
// The push service only accepts pushes signed by the private half of the key
// a subscription was created with: a notifier with another keypair = no
// pushes (the endpoint answers 401/403 to the notifier).
export const VAPID_KEY = "BHNce1sXk99bpkFFYwiSR3Lp4n54PiS-Y0S9iX6R7va7sxQ5hE7ll6DMKlKs2tFT9POq92gLygezT7o0fkQU8NE";
export const PREF_KEY = "velta-webpush";        // "1" = user turned it on
export const TOKEN_KEY = "velta-webpush-token"; // last token handed to the core (diagnostics only)

/** base64url (no padding) → Uint8Array, as pushManager.subscribe wants. */
export function urlBase64ToUint8Array(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (String(s).length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Notifier token from a PushSubscription (or its toJSON()). Keys are
 * base64url without padding — what notifiers' WebPush parser decodes.
 */
export function buildWebPushToken(sub) {
  const j = typeof sub?.toJSON === "function" ? sub.toJSON() : sub;
  const endpoint = j?.endpoint;
  const p256dh = j?.keys?.p256dh;
  const auth = j?.keys?.auth;
  if (!endpoint || !p256dh || !auth) throw new Error("push subscription without endpoint/keys");
  if (!/^https:\/\//.test(endpoint)) throw new Error("push endpoint is not https");
  const strip = (k) => String(k).replace(/=+$/, "");
  if (endpoint.includes("|")) throw new Error("push endpoint contains '|'");
  return `webpush:${endpoint}|${strip(p256dh)}|${strip(auth)}`;
}

/** Same subscription key? (applicationServerKey from subscription.options). */
export function sameServerKey(buf, key = VAPID_KEY) {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  const b = urlBase64ToUint8Array(key);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function isIos(nav = globalThis.navigator) {
  const ua = nav?.userAgent || "";
  return /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints || 0) > 1);
}

/** iOS major.minor from the UA ("OS 16_4" / "Version/16.4"), or null. */
export function iosVersion(nav = globalThis.navigator) {
  const ua = nav?.userAgent || "";
  const m = ua.match(/OS (\d+)[_.](\d+)/) || ua.match(/Version\/(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function isStandalone(win = globalThis) {
  try {
    if (win.navigator?.standalone === true) return true;
    return !!win.matchMedia?.("(display-mode: standalone)")?.matches;
  } catch { return false; }
}

/**
 * What the browser allows. { ok, reason, hint }:
 * reason ∈ ok | no-sw | no-push | ios-old | ios-not-installed | denied.
 */
export function webPushSupport(win = globalThis) {
  const nav = win.navigator;
  const ios = isIos(nav);
  if (ios) {
    const v = iosVersion(nav);
    if (v && (v[0] < 16 || (v[0] === 16 && v[1] < 4))) return { ok: false, reason: "ios-old", hint: "Push needs iOS 16.4 or newer." };
    if (!isStandalone(win)) return { ok: false, reason: "ios-not-installed", hint: "On iPhone/iPad, push works only for the installed app: Share → Add to Home Screen, then open Velta from the home screen and turn this on there." };
  }
  if (!nav?.serviceWorker) return { ok: false, reason: "no-sw", hint: "This browser has no service workers (private mode?), so it can't receive push." };
  if (!("PushManager" in win) || !("Notification" in win)) return { ok: false, reason: "no-push", hint: ios ? "Open Velta from the home screen icon to use push." : "This browser doesn't support Web Push." };
  if (win.Notification.permission === "denied") return { ok: false, reason: "denied", hint: "Notifications are blocked for this site — allow them in the browser's site settings." };
  return { ok: true, reason: "ok", hint: "" };
}

export function pushEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(PREF_KEY) === "1"; } catch { return false; }
}

/** Short endpoint origin for the status line (never the full capability URL). */
export function endpointHost(token) {
  const m = /^webpush:(https:\/\/[^/|]+)/.exec(String(token || ""));
  try { return m ? new URL(m[1]).host : ""; } catch { return ""; }
}

export function webPushBodyHtml({ on, support, status = "" }) {
  const esc = escapeHtml;
  return `
    <label class="scale-opt"><input type="checkbox" role="switch" data-webpush-toggle${on ? " checked" : ""}${!support.ok && !on ? " disabled" : ""}><span>Notify me when Velta is closed</span></label>
    ${support.ok ? "" : `<div class="bar-opts-hint" data-webpush-hint>${esc(support.hint)}</div>`}
    <div class="bar-opts-hint" data-webpush-status role="status" aria-live="polite">${esc(status)}</div>
    <div class="bar-opts-hint">Your relay pings this browser's push service through notifications.delta.chat; the notification only says "New message" — open Velta to fetch it.</div>`;
}

async function registration(nav) {
  // ready never settles without a registered SW; bound it.
  let timer;
  return Promise.race([
    nav.serviceWorker.ready,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("service worker not ready")), 8000); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Current (or fresh) subscription for VAPID_KEY. A subscription made with
 * another key is dropped first (subscribe() would throw InvalidStateError).
 */
export async function ensureSubscription(nav = globalThis.navigator) {
  const reg = await registration(nav);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameServerKey(sub.options?.applicationServerKey)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_KEY) });
  return sub;
}

/** Hand the token to the core (all accounts). */
export async function registerToken(core, token, storage = globalThis.localStorage) {
  const t = core?.transport;
  if (typeof t?.setPushDeviceToken !== "function") throw new Error("this core can't take a push token (not the wasm PWA)");
  await t.setPushDeviceToken(token);
  try { storage?.setItem(TOKEN_KEY, token); } catch { /* quota */ }
}

/** Turn on: permission (must run in a user gesture) → subscribe → register. */
export async function enableWebPush(core, { win = globalThis, storage = win.localStorage } = {}) {
  const sup = webPushSupport(win);
  if (!sup.ok) throw new Error(sup.hint);
  const perm = await win.Notification.requestPermission();
  if (perm !== "granted") throw new Error(perm === "denied" ? "Notifications are blocked for this site" : "Notification permission not granted");
  const sub = await ensureSubscription(win.navigator);
  const token = buildWebPushToken(sub);
  await registerToken(core, token, storage);
  storage.setItem(PREF_KEY, "1");
  return token;
}

/**
 * Turn off: drop the browser subscription. The endpoint then answers 404/410,
 * which makes the notifier forget it; the core's in-memory token is gone at
 * the next boot (it is never re-registered while the pref is off).
 */
export async function disableWebPush({ win = globalThis, storage = win.localStorage } = {}) {
  storage.removeItem(PREF_KEY);
  storage.removeItem(TOKEN_KEY);
  try {
    const reg = await registration(win.navigator);
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch { /* no SW / no sub: nothing to undo */ }
}

/**
 * Every boot and on SW "velta-push-subscription-changed": re-subscribe if
 * needed and hand the token to the core again. Silent unless `log` is given.
 */
export async function refreshWebPush(core, { win = globalThis, storage = win.localStorage, log } = {}) {
  if (!pushEnabled(storage)) return null;
  if (!webPushSupport(win).ok || win.Notification.permission !== "granted") { log?.("warning", "Web Push is on but the browser no longer allows it"); return null; }
  try {
    const token = buildWebPushToken(await ensureSubscription(win.navigator));
    await registerToken(core, token, storage);
    log?.("info", `Web Push token registered (${endpointHost(token)})`);
    return token;
  } catch (e) {
    log?.("warning", "Web Push registration failed: " + (e?.message || e));
    return null;
  }
}

/** Wire the drawer <details>. */
export function wireWebPushSection(details, { core, toast, errToast, win = globalThis }) {
  if (!details) return;
  const body = details.querySelector("[data-webpush-body]");
  const summary = details.querySelector("[data-webpush-summary]");
  const storage = win.localStorage;
  const paint = (status) => {
    const on = pushEnabled(storage);
    const tok = storage.getItem(TOKEN_KEY);
    body.innerHTML = webPushBodyHtml({ on, support: webPushSupport(win), status: status ?? (on ? (tok ? `On — via ${endpointHost(tok)}` : "On") : "Off") });
    if (summary) summary.textContent = `Push notifications: ${on ? "on" : "off"}`;
  };
  details.addEventListener("toggle", () => { if (details.open) paint(); });
  body.addEventListener("change", async (e) => {
    const input = e.target;
    if (!input?.matches?.("[data-webpush-toggle]")) return;
    input.disabled = true;
    try {
      if (input.checked) { await enableWebPush(core, { win, storage }); toast?.("Push notifications on"); }
      else { await disableWebPush({ win, storage }); toast?.("Push notifications off"); }
      paint();
    } catch (err) {
      if (input.checked) await disableWebPush({ win, storage });
      errToast?.("Push notifications: " + (err?.message || err));
      paint("Off — " + (err?.message || err));
    }
  });
  paint();
}
