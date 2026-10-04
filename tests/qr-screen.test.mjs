import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isMobileUa, isAndroidUa, scanTabAvailable, canShareLink, copyLink, shareLink, classifyScannedCode,
} from "../app/js/qr-actions.js";

// #37: "Your QR code" screen — tabs (My code / Scan a QR code on phones),
// "Copy a link" (was "Scan a code instead") and "Share a link" (native).

const read = rel => readFileSync(new URL(rel, import.meta.url), "utf8");
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

test("platform detection", () => {
  assert.equal(isMobileUa(ANDROID), true);
  assert.equal(isMobileUa(IPHONE), true);
  assert.equal(isMobileUa(WINDOWS), false);
  assert.equal(isMobileUa(LINUX), false);
  assert.equal(isMobileUa(undefined), false);
  assert.equal(isAndroidUa(ANDROID), true);
  assert.equal(isAndroidUa(IPHONE), false);
});

test("the scan tab exists on phones with a camera API only", () => {
  assert.equal(scanTabAvailable({ ua: ANDROID, hasCamera: true }), true);
  assert.equal(scanTabAvailable({ ua: IPHONE, hasCamera: true }), true);
  assert.equal(scanTabAvailable({ ua: ANDROID, hasCamera: false }), false);
  assert.equal(scanTabAvailable({ ua: WINDOWS, hasCamera: true }), false);
  assert.equal(scanTabAvailable({ ua: LINUX, hasCamera: true }), false);
});

test("share button: Android shell command or Web Share, otherwise hidden", () => {
  assert.equal(canShareLink({ ua: ANDROID, hasInvoke: true, hasWebShare: false }), true);
  assert.equal(canShareLink({ ua: ANDROID, hasInvoke: false, hasWebShare: false }), false);
  assert.equal(canShareLink({ ua: WINDOWS, hasInvoke: true, hasWebShare: true }), true);
  assert.equal(canShareLink({ ua: WINDOWS, hasInvoke: true, hasWebShare: false }), false);
  assert.equal(canShareLink({ ua: LINUX, hasInvoke: true, hasWebShare: false }), false);
});

test("copyLink writes exactly the link", async () => {
  const written = [];
  await copyLink("https://i.delta.chat/#ABC&v=3", { clipboard: { writeText: async t => { written.push(t); } } });
  assert.deepEqual(written, ["https://i.delta.chat/#ABC&v=3"]);
  await assert.rejects(copyLink("", { clipboard: { writeText: async () => {} } }), /no link/);
  await assert.rejects(copyLink("x", { clipboard: null }), /clipboard/);
});

test("shareLink: Android uses the shell command with the link as plain text", async () => {
  const calls = [];
  const r = await shareLink("https://i.delta.chat/#ABC", {
    ua: ANDROID, invoke: async (cmd, args) => { calls.push([cmd, args]); },
    webShare: async () => assert.fail("must not use Web Share on Android"),
  });
  assert.equal(r, "shared");
  assert.deepEqual(calls, [["share_text", { text: "https://i.delta.chat/#ABC", title: "Velta invite" }]]);
});

test("shareLink: Android shell failure propagates (caller toasts)", async () => {
  await assert.rejects(
    shareLink("l", { ua: ANDROID, invoke: async () => { throw new Error("no app can handle the share request"); } }),
    /no app can handle/,
  );
});

test("shareLink: desktop uses Web Share; dismissing the sheet is not an error", async () => {
  const seen = [];
  assert.equal(await shareLink("L", { ua: WINDOWS, invoke: async () => assert.fail(), webShare: async o => { seen.push(o); } }), "shared");
  assert.deepEqual(seen, [{ title: "Velta invite", text: "L" }]);
  const abort = Object.assign(new Error("x"), { name: "AbortError" });
  assert.equal(await shareLink("L", { ua: WINDOWS, webShare: async () => { throw abort; } }), "cancelled");
  await assert.rejects(shareLink("L", { ua: WINDOWS, webShare: async () => { throw new Error("denied"); } }), /denied/);
  await assert.rejects(shareLink("L", { ua: WINDOWS }), /not available/);
  await assert.rejects(shareLink("", { ua: ANDROID, invoke: async () => {} }), /no link/);
});

test("classifyScannedCode: only invites, relay invites and backups are acted on", () => {
  const helpers = {
    parseInviteLink: s => (/^https:\/\/i\.delta\.chat\/#|^OPENPGP4FPR:/i.test(s) ? { raw: s } : null),
    isShortInviteLink: s => /^https:\/\/deltachat\.id\/[a-z]+$/i.test(s),
  };
  const c = s => classifyScannedCode(s, helpers);
  assert.equal(c("https://i.delta.chat/#AAAA&v=3"), "invite");
  assert.equal(c("OPENPGP4FPR:AAAA#a=x"), "invite");
  assert.equal(c("https://deltachat.id/alice"), "short");
  assert.equal(c("dcaccount:https://nine.testrun.org/new"), "relay");
  assert.equal(c("DCLOGIN:imap://x"), "relay");
  assert.equal(c("dcbackup2:abc"), "backup");
  assert.equal(c("  https://i.delta.chat/#AAAA  "), "invite");
  // everything else is ignored — in particular no deep-link scheme can ride a QR
  for (const bad of ["", "   ", null, "https://example.com", "velta://chat?account=1&chat=2&t=x", "javascript:alert(1)",
    "velta://invite?url=x", "hello", "mailto:a@b.c", "WIFI:S:x;;"]) assert.equal(c(bad), null, String(bad));
});

// ---- source-level integrity of the screen and the native bridge ----

const fn = (src, name) => {
  const i = src.indexOf(`function ${name}(`);
  assert.notEqual(i, -1, `missing ${name}`);
  const j = src.indexOf("\nfunction ", i + 10);
  const k = src.indexOf("\n// #57 category bar", i);
  return src.slice(i, k > i ? k : j);
};
const rawApp = read("../app/js/app.js");

test("renderQrView: tabs, Copy/Share buttons, old button gone", () => {
  const body = fn(rawApp, "renderQrView");
  assert.ok(body.includes("Copy a link"));
  assert.ok(body.includes("Share a link"));
  assert.ok(body.includes("My code"));
  assert.ok(body.includes("Scan a QR code"));
  assert.ok(!body.includes("Scan a code instead"), "renamed to Copy a link");
  assert.ok(!/joinFlow\(\)/.test(body), "the paste-a-link flow lives in the New chat menu, not here");
  // the scan tab is gated, and the camera starts from the tab, not from opening the screen
  assert.match(body, /scanTabAvailable\(/);
  assert.match(body, /canShareLink\(/);
  assert.match(body, /mountScanner\(/);
});

test("scan results are classified before any handler runs; velta:// never reaches the deep-link router", () => {
  const body = fn(rawApp, "renderQrView");
  const onCode = body.slice(body.indexOf("onCode:"), body.indexOf("retry.addEventListener"));
  assert.match(onCode, /classifyScannedCode\(raw/);
  assert.match(onCode, /if \(!kind\)/);
  assert.ok(onCode.indexOf("classifyScannedCode") < onCode.indexOf("joinFromInvite"));
  assert.ok(onCode.indexOf("classifyScannedCode") < onCode.indexOf("handleDeeplinkFromUrl"));
});

test("leaving the QR view stops the camera", () => {
  const set = fn(rawApp, "setListView");
  assert.match(set, /stopQrScanner\(\)/);
  assert.match(strip(read("../app/js/qr-scan.js")), /visibilitychange/);
  assert.match(strip(read("../app/js/qr-scan.js")), /export function mountScanner/);
});

test("Android share: Share.kt, JNI class cache, command registered for android and non-android", () => {
  const kt = strip(read("../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/Share.kt"));
  assert.match(kt, /object Share/);
  assert.match(kt, /@JvmStatic\s+fun text\(context: Context, text: String, title: String\): Boolean/);
  assert.match(kt, /Intent\.ACTION_SEND/);
  assert.match(kt, /"text\/plain"/);
  assert.match(kt, /createChooser/);
  assert.match(kt, /FLAG_ACTIVITY_NEW_TASK/);
  const rs = strip(read("../velta-app/src-tauri/src/lib.rs"));
  assert.equal((rs.match(/fn share_text\(/g) || []).length, 2, "android + stub");
  assert.match(rs, /find_class\("org\/velta\/Share"\)/);
  assert.match(rs, /APP_SHARE_CLASS/);
  assert.match(rs, /"\(Landroid\/content\/Context;Ljava\/lang\/String;Ljava\/lang\/String;\)Z"/);
  assert.match(rs, /generate_handler!\[[^\]]*\bshare_text\b/);
  assert.match(strip(read("../app/js/qr-actions.js")), /invoke\("share_text", \{ text: link, title \}\)/);
});
