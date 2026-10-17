import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePushStatus, selectedValue, describePushState, describeRelaySupport, describeLastPush, pushBodyHtml, OFF_VALUE, PUSH_APP_URL } from "../app/js/push-settings.js";

const mem = (o = {}) => { const m = new Map(Object.entries(o)); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
const ntfy = { pkg: "io.heckel.ntfy", label: "ntfy" };
const np = { pkg: "org.unifiedpush.nextpush", label: "NextPush" };

test("parsePushStatus tolerates junk", () => {
  assert.deepEqual(parsePushStatus("not json"), { distributors: [], saved: "", savedLabel: "", optedOut: false, lastPush: 0 });
  const s = parsePushStatus(JSON.stringify({ distributors: [ntfy, { pkg: "" }, null], saved: "io.heckel.ntfy", optedOut: true, lastPush: 5 }));
  assert.equal(s.distributors.length, 1);
  assert.equal(s.lastPush, 5);
});

test("state line + selection", () => {
  const none = parsePushStatus({});
  assert.match(describePushState(none), /No push app installed — using periodic background checks/);
  assert.equal(selectedValue(none), "");
  const using = parsePushStatus({ distributors: [ntfy, np], saved: ntfy.pkg });
  assert.equal(describePushState(using), "Using ntfy");
  assert.equal(selectedValue(using), ntfy.pkg);
  const off = parsePushStatus({ distributors: [ntfy, np], optedOut: true });
  assert.match(describePushState(off), /^Off/);
  assert.equal(selectedValue(off), OFF_VALUE);
});

test("picker lists every distributor plus Off; get-app link only without one", () => {
  const html = pushBodyHtml(parsePushStatus({ distributors: [ntfy, np], saved: np.pkg }));
  assert.equal((html.match(/name="push-distributor"/g) || []).length, 3);
  assert.match(html, /value="org.unifiedpush.nextpush" checked/);
  assert.match(html, /<legend class="vh">Push app<\/legend>/);
  assert.doesNotMatch(html, /data-push-get/);
  const empty = pushBodyHtml(parsePushStatus({}));
  assert.match(empty, new RegExp(`href="${PUSH_APP_URL}" data-push-get`));
  assert.doesNotMatch(empty, /push-distributor/);
  assert.match(pushBodyHtml(parsePushStatus({ distributors: [{ pkg: "x", label: "<b>" }] })), /&lt;b&gt;/);
});

test("relay support line reuses relay-push cache", () => {
  const st = mem({ "velta.relayPush": JSON.stringify({ "a.org": { supported: true } }) });
  assert.equal(describeRelaySupport(["me@a.org"], st), "Your relay supports push");
  assert.equal(describeRelaySupport(["me@a.org", "me@b.org"], st), "1 of 2 relays support push");
  assert.match(describeRelaySupport(["me@b.org"], st), /not confirmed/);
  assert.match(describeRelaySupport([], st), /unknown/);
});

test("last push line", () => {
  assert.equal(describeLastPush(0), "No push received yet");
  assert.match(describeLastPush(Date.now()), /^Last push: /);
});

test("drawer section is a native <details>, Android-only, wired in app.js; shell commands exist", () => {
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /IS_ANDROID && onPushSection \? `<details class="drawer-details" data-push-section>/);
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app, /onPushSection: \(el\) => wirePushSection\(/);
  const lib = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const c of ["push_status", "push_select", "push_off"]) assert.match(lib, new RegExp(`\\b${c}\\b.*share_text`));
  const svc = readFileSync(new URL("../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/UnifiedPushService.kt", import.meta.url), "utf8");
  assert.match(svc, /UnifiedPushBridge\.optedOut\(context\)/);
  assert.match(svc, /KEY_LAST_PUSH/);
});
