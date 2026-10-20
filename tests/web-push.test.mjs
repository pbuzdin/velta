import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  VAPID_KEY, PREF_KEY, TOKEN_KEY, urlBase64ToUint8Array, buildWebPushToken, sameServerKey, isIos, iosVersion,
  webPushSupport, endpointHost, webPushBodyHtml, enableWebPush, disableWebPush, refreshWebPush, ensureSubscription,
} from "../app/js/web-push.js";

const src = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };

test("VAPID key is the notifier key shared with the Android UnifiedPush flavor", () => {
  const kt = src("velta-app/src-tauri/gen/android/app/src/main/java/org/velta/UnifiedPushService.kt");
  assert.ok(kt.includes(`"${VAPID_KEY}"`));
  const raw = urlBase64ToUint8Array(VAPID_KEY);
  assert.equal(raw.length, 65); // uncompressed P-256 point
  assert.equal(raw[0], 4);
  assert.ok(sameServerKey(raw.buffer));
  assert.ok(!sameServerKey(new Uint8Array(65).buffer));
  assert.ok(!sameServerKey(null));
});

test("token is webpush:<endpoint>|<p256dh>|<auth> with unpadded keys", () => {
  const sub = { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/abc:DEF", keys: { p256dh: "BPk_x-1==", auth: "aA_b" } }) };
  assert.equal(buildWebPushToken(sub), "webpush:https://fcm.googleapis.com/fcm/send/abc:DEF|BPk_x-1|aA_b");
  assert.throws(() => buildWebPushToken({ endpoint: "https://x", keys: {} }));
  assert.throws(() => buildWebPushToken({ endpoint: "http://x", keys: { p256dh: "a", auth: "b" } }));
  assert.throws(() => buildWebPushToken({ endpoint: "https://x/a|b", keys: { p256dh: "a", auth: "b" } }));
  assert.equal(endpointHost("webpush:https://updates.push.services.mozilla.com/wpush/v2/x|a|b"), "updates.push.services.mozilla.com");
  assert.equal(endpointHost("junk"), "");
});

const iphone = (v) => `Mozilla/5.0 (iPhone; CPU iPhone OS ${v} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v.replace("_", ".")} Mobile/15E148 Safari/604.1`;
const win = ({ ua = "Mozilla/5.0 (X11; Linux x86_64) Chrome/140", standalone = false, perm = "default", sw = true, push = true, subKey = null } = {}) => {
  const calls = [];
  let current = null;
  const pushManager = {
    getSubscription: async () => current,
    subscribe: async (opts) => { calls.push(["subscribe", opts]); current = mkSub(opts.applicationServerKey); return current; },
  };
  const mkSub = (key) => ({
    options: { applicationServerKey: key.buffer ?? key },
    toJSON: () => ({ endpoint: "https://push.example/ep1", keys: { p256dh: "P", auth: "A" } }),
    unsubscribe: async () => { calls.push(["unsubscribe"]); current = null; return true; },
  });
  if (subKey) current = mkSub(subKey);
  const w = {
    navigator: { userAgent: ua, maxTouchPoints: 0, ...(sw ? { serviceWorker: { ready: Promise.resolve({ pushManager }) } } : {}) },
    matchMedia: () => ({ matches: standalone }),
    Notification: { permission: perm, requestPermission: async () => { w.Notification.permission = "granted"; return "granted"; } },
    localStorage: mem(),
    calls, mkSub,
  };
  if (push) w.PushManager = function () {};
  return w;
};

test("support: iOS needs 16.4+ and a home-screen install", () => {
  assert.ok(isIos({ userAgent: iphone("17_2") }));
  assert.deepEqual(iosVersion({ userAgent: iphone("16_3") }), [16, 3]);
  assert.equal(webPushSupport(win({ ua: iphone("16_3"), standalone: true })).reason, "ios-old");
  const notInstalled = webPushSupport(win({ ua: iphone("17_2") }));
  assert.equal(notInstalled.reason, "ios-not-installed");
  assert.match(notInstalled.hint, /Add to Home Screen/);
  assert.equal(webPushSupport(win({ ua: iphone("17_2"), standalone: true })).ok, true);
  assert.equal(webPushSupport(win({ sw: false })).reason, "no-sw");
  assert.equal(webPushSupport(win({ push: false })).reason, "no-push");
  assert.equal(webPushSupport(win({ perm: "denied" })).reason, "denied");
  assert.equal(webPushSupport(win()).ok, true);
});

test("enable: permission → subscribe with VAPID key → token to core; refresh re-registers; off unsubscribes", async () => {
  const w = win();
  const tokens = [];
  const core = { transport: { setPushDeviceToken: async (t) => { tokens.push(t); } } };
  const t = await enableWebPush(core, { win: w });
  assert.equal(t, "webpush:https://push.example/ep1|P|A");
  const [kind, opts] = w.calls[0];
  assert.equal(kind, "subscribe");
  assert.equal(opts.userVisibleOnly, true);
  assert.ok(sameServerKey(opts.applicationServerKey.buffer));
  assert.equal(w.localStorage.getItem(PREF_KEY), "1");
  assert.equal(w.localStorage.getItem(TOKEN_KEY), t);
  // boot: same subscription, token handed over again, no new subscribe
  assert.equal(await refreshWebPush(core, { win: w }), t);
  assert.deepEqual(tokens, [t, t]);
  assert.equal(w.calls.filter(c => c[0] === "subscribe").length, 1);
  await disableWebPush({ win: w });
  assert.equal(w.localStorage.getItem(PREF_KEY), null);
  assert.ok(w.calls.some(c => c[0] === "unsubscribe"));
  assert.equal(await refreshWebPush(core, { win: w }), null); // off: never re-registered
  assert.equal(tokens.length, 2);
});

test("a subscription under a foreign key is replaced; a core without the binding fails clearly", async () => {
  const w2 = win({ subKey: new Uint8Array(65) });
  await ensureSubscription(w2.navigator);
  assert.deepEqual(w2.calls.map(c => c[0]), ["unsubscribe", "subscribe"]);
  await assert.rejects(enableWebPush({ transport: {} }, { win: win() }), /can't take a push token/);
});

test("drawer body: switch, iOS hint, escaping", () => {
  const html = webPushBodyHtml({ on: false, support: { ok: false, hint: "<x>" }, status: "Off" });
  assert.match(html, /data-webpush-toggle disabled/);
  assert.match(html, /&lt;x&gt;/);
  assert.doesNotMatch(webPushBodyHtml({ on: true, support: { ok: true, hint: "" } }), /disabled|data-webpush-hint/);
});

test("wiring: worker handles set-push-token, transport exposes it, drawer + boot hooks, SW push handler", () => {
  assert.match(src("app/js/worker-wasm.js"), /d\.type === "set-push-token"[\s\S]*dc\.set_push_device_token/);
  assert.match(src("app/js/transport-worker-wasm.js"), /setPushDeviceToken\(token\)[\s\S]*"set-push-token"/);
  assert.match(src("packages/velta-wasm/rust/src/lib.rs"), /pub async fn set_push_device_token\(&self, token: String\)/);
  const ui = src("app/js/ui.js");
  assert.match(ui, /<details class="drawer-details" data-webpush-section>/);
  const app = src("app/js/app.js");
  assert.match(app, /refreshWebPush\(core/);
  assert.match(app, /velta-push-subscription-changed/);
  const b = src("scripts/build-pwa.mjs");
  assert.match(b, /addEventListener\('push'/);
  assert.match(b, /c\.focused && c\.visibilityState === 'visible'/);
  assert.match(b, /tag: 'velta-push'/);
  assert.match(b, /addEventListener\('pushsubscriptionchange'/);
});
