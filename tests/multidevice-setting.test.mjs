import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MD_CHOICE_KEY, MD_HINT, MD_REENABLED_NOTE, DL_LIMIT_HINT, MD_RETRY_DELAYS,
  getChoice, recordChoice, markNotified, forgetAccount, classify, mdLabel, retryDelay, offConfirmText,
} from "../app/js/multidevice.js";

const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}

test("the drawer multi-device checkbox is the core bcc_self setting", () => {
  assert.match(ui, /data-toggle="multidevice"/);
  assert.match(app, /core\.getConfig\("bcc_self"\)/);
  assert.match(app, /setConfig\("bcc_self", on \? "1" : "0"\)/);
  // No localStorage copy of the VALUE: the only stored thing is the user's
  // last choice, kept by multidevice.js and never rendered.
  assert.doesNotMatch(app, /localStorage\.(get|set)Item\("velta-(bcc|multidevice)/);
  assert.doesNotMatch(app, /multiDeviceOn\b/);
});

test("(a) a failed read shows unknown + indeterminate and retries, never 'off'", () => {
  assert.equal(mdLabel("unknown"), "unknown");
  assert.equal(mdLabel("loading"), "…");
  assert.equal(mdLabel("on"), "on");
  assert.equal(mdLabel("off"), "off");
  const ensure = app.slice(app.indexOf("function ensureMultiDevice()"), app.indexOf("async function setMultiDevice("));
  assert.match(ensure, /\.catch\(err => \{[\s\S]*multiDeviceState = "unknown";[\s\S]*setTimeout\([\s\S]*ensureMultiDevice\(\)/);
  assert.doesNotMatch(ensure, /\.catch\(\(\) => \{\}\)/, "the read failure must not be swallowed");
  assert.match(app, /box\.indeterminate = !known;/);
  assert.match(ui, /mdBox\.indeterminate = true/);
  assert.match(ui, /aria-checked="mixed"/);
  // backoff grows and then holds at the last delay
  assert.equal(retryDelay(0), MD_RETRY_DELAYS[0]);
  assert.ok(retryDelay(1) > retryDelay(0));
  assert.equal(retryDelay(99), MD_RETRY_DELAYS.at(-1));
  assert.equal(retryDelay(-3), MD_RETRY_DELAYS[0]);
});

test("(a) state lives above the boot awaits (no TDZ from early events)", () => {
  const stateAt = app.indexOf('let multiDeviceState = "loading"');
  assert.ok(stateAt > 0 && stateAt < app.indexOf("await coreStartupPromise"));
});

test("(b) hint under the switch; switching off confirms, stronger after a core flip", () => {
  assert.equal(MD_HINT, "Off: messages are deleted from the relay after this device downloads them. Turn on if you use this profile on other devices.");
  assert.match(ui, /data-md-hint>\$\{escapeHtml\(t\(MD_HINT\)\)\}/);
  assert.match(app, /confirmModal\("Turn off multi-device\?", mdOffConfirmText\(multiDeviceReenabled\), "Turn off", true\)/);
  assert.match(offConfirmText(false), /Keep it on if you use this profile anywhere else/);
  assert.match(offConfirmText(true), /another device may still be using this profile/);
  // a cancelled confirm reverts the switch (ui.js reverts on false)
  assert.match(ui, /if \(ok === false && e\.target\.isConnected\) setToggleUi\("multidevice", "Multi-device", !on\)/);
});

test("(c) download-limit note: skipped files stay on the relay; AGENTS.md fixed", () => {
  assert.match(DL_LIMIT_HINT, /stay on the relay/);
  assert.match(DL_LIMIT_HINT, /about 7 days/);
  assert.match(ui, /data-dl-hint>\$\{escapeHtml\(t\(DL_LIMIT_HINT\)\)\}/);
  assert.doesNotMatch(ui, /Regular messages are always downloaded/);
  assert.doesNotMatch(agents, /caps the SECOND-DEVICE history\s+sync only; regular messages always auto-download/);
});

test("(d) classify: seeds a baseline, flags an unasked 0 -> 1 once", () => {
  assert.deepEqual(classify("0", null), { state: "off", reenabled: false, notify: false, seed: true });
  assert.deepEqual(classify("1", { choice: "0" }), { state: "on", reenabled: true, notify: true, seed: false });
  assert.deepEqual(classify("1", { choice: "0", notified: true }), { state: "on", reenabled: true, notify: false, seed: false });
  assert.deepEqual(classify("1", { choice: "1" }), { state: "on", reenabled: false, notify: false, seed: false });
  assert.deepEqual(classify("0", { choice: "1" }), { state: "off", reenabled: false, notify: false, seed: false });
  assert.equal(classify(null, { choice: "0" }).state, "off");
});

test("(d) choice storage is per account and survives junk", () => {
  const s = memStorage();
  assert.equal(getChoice(s, 1), null);
  recordChoice(s, 1, false);
  recordChoice(s, 2, true);
  assert.deepEqual(getChoice(s, 1), { choice: "0" });
  assert.deepEqual(getChoice(s, "2"), { choice: "1" });
  markNotified(s, 1);
  assert.deepEqual(getChoice(s, 1), { choice: "0", notified: true });
  // a new choice clears the notified flag
  recordChoice(s, 1, false);
  assert.deepEqual(getChoice(s, 1), { choice: "0" });
  forgetAccount(s, 1);
  assert.equal(getChoice(s, 1), null);
  assert.deepEqual(getChoice(s, 2), { choice: "1" });
  assert.equal(getChoice(memStorage({ [MD_CHOICE_KEY]: "not json" }), 1), null);
  assert.equal(getChoice(memStorage({ [MD_CHOICE_KEY]: "[1]" }), 0), null);
  assert.equal(getChoice(memStorage({ [MD_CHOICE_KEY]: '{"1":{"choice":"x"}}' }), 1), null);
  assert.equal(getChoice(s, null), null);
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.doesNotThrow(() => recordChoice(throwing, 1, true));
  assert.equal(getChoice(throwing, 1), null);
});

test("(d) the app notices and offers Turn off again, never reverts on its own", () => {
  assert.match(MD_REENABLED_NOTE, /backup export, Add second device, or a sync from another device/);
  assert.match(ui, /data-md-note\$\{multiDeviceReenabled \? "" : " hidden"\}/);
  assert.match(ui, /data-md-off>\$\{t\("Turn off again"\)\}</);
  assert.match(ui, /data-md-keep>\$\{t\("Keep on"\)\}</);
  assert.match(app, /action: \{ label: "Turn off again", run: turnMultiDeviceOffAgain \}/);
  assert.match(app, /markMdNotified\(localStorage, accountId\)/);
  // checked on resume and when a backup/transfer finishes
  const resume = app.slice(app.indexOf("function refreshAfterBackground()"), app.indexOf("function reportUiVisible()"));
  assert.match(resume, /ensureMultiDevice\(\)/);
  assert.match(app, /core\.addEventListener\("imex-progress", e => \{\s*const p = e\.detail\?\.progress;\s*if \(p === 1000 \|\| p === 0\) setTimeout\(\(\) => ensureMultiDevice\(\)/);
  // the only bcc_self writes are user-driven (switch / Turn off again)
  assert.equal((app.match(/setConfig\("bcc_self"/g) || []).length, 1);
  const ensure = app.slice(app.indexOf("function ensureMultiDevice()"), app.indexOf("async function setMultiDevice("));
  assert.doesNotMatch(ensure, /setConfig/);
});

test("toast supports one action button", () => {
  assert.match(ui, /opts\.action && typeof opts\.action\.run === "function"/);
});
