import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseSharePayload, shareTextIfUnconsumed, shareViewtype, shareTargets, sharePlan, shareStageKind,
  createShareInbox, buildSharePicker,
} from "../app/js/share-in.js";

// #97: Velta shows up in the Android share sheet and Windows Send to, and
// the page can tell a shared file or text from an invite link.

test("parseSharePayload keeps text and files, and leaves links to the deeplink router", () => {
  assert.deepEqual(parseSharePayload("data:text/plain,hello%20there"), { text: "hello there" });
  assert.deepEqual(parseSharePayload("data:text/plain;charset=utf-8,hi"), { text: "hi" });
  assert.equal(parseSharePayload("data:text/plain,"), null);
  assert.deepEqual(parseSharePayload("content://media/external/images/1"), { file: "content://media/external/images/1" });
  assert.deepEqual(parseSharePayload("file:///C:/Users/a%20b/x.png"), { file: "C:/Users/a b/x.png" });
  assert.deepEqual(parseSharePayload("file:///storage/emulated/0/DCIM/a.jpg"), { file: "/storage/emulated/0/DCIM/a.jpg" });
  assert.deepEqual(parseSharePayload("C:\\Users\\a b\\x.png"), { file: "C:\\Users\\a b\\x.png" });
  assert.deepEqual(parseSharePayload("\\\\server\\share\\a.png"), { file: "\\\\server\\share\\a.png" });
  assert.equal(parseSharePayload("velta://chat?chat=1"), null);
  assert.equal(parseSharePayload("https://example.com/a"), null);
  assert.equal(parseSharePayload("dcaccount:https://example.org/new"), null);
  assert.equal(parseSharePayload(""), null);
});

test("an https URL is shared text only when the deeplink router did not consume it", () => {
  assert.deepEqual(shareTextIfUnconsumed("https://example.com/a", false), { text: "https://example.com/a" });
  assert.equal(shareTextIfUnconsumed("https://i.delta.chat/#ABC", true), null);
  assert.equal(shareTextIfUnconsumed("velta://chat?chat=1", false), null);
  // tao passes EXTRA_TEXT that parses as a URL through as-is.
  assert.deepEqual(shareTextIfUnconsumed("re: lunch%20at%20one", false), { text: "re: lunch at one" });
  assert.deepEqual(shareTextIfUnconsumed("mailto:a@example.org", false), { text: "mailto:a@example.org" });
  for (const owned of ["dcaccount:https://x/new", "openpgp4fpr:ABC", "dclogin:a@b", "data:text/plain,", "content://x"]) {
    assert.equal(shareTextIfUnconsumed(owned, false), null, owned);
  }
  assert.equal(shareTextIfUnconsumed("plain words", false), null);
});

test("share viewtype follows the file extension", () => {
  assert.equal(shareViewtype("a/b.JPG"), "image");
  assert.equal(shareViewtype("clip.mp4"), "video");
  assert.equal(shareViewtype("song.opus"), "audio");
  assert.equal(shareViewtype("notes.pdf"), "file");
});

test("the Android activity registers as a share target", () => {
  const manifest = readFileSync(new URL("../velta-app/src-tauri/gen/android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  const activity = manifest.slice(manifest.indexOf('android:name=".MainActivity"'), manifest.indexOf("</activity>"));
  assert.match(activity, /android.intent.action.SEND"/);
  assert.match(activity, /android.intent.action.SEND_MULTIPLE"/);
  assert.match(activity, /android.intent.category.DEFAULT/);
  for (const mime of ["text/plain", "image/*", "video/*", "audio/*", "application/*", "*/*"]) {
    assert.match(activity, new RegExp(`android:mimeType="${mime.replaceAll("*", "\\*")}"`));
  }
});

test("opened urls are drained into the share picker, not dropped", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app, /take_opened_urls/);
  assert.match(app, /parseSharePayload/);
  assert.match(app, /Share to…/);
});

test("boot opens the share inbox only after the chat list and the first drain", () => {
  // Sharing cold-starts the app: the picker must not open before the chat
  // list exists, and a wake-up lost while the WebView slept is drained again.
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const boot = app.slice(app.indexOf("async function boot("));
  const list = boot.indexOf("await refreshChatList()");
  const drain = boot.indexOf("await drainOpened()");
  const ready = boot.indexOf("shareInbox.ready()");
  assert.ok(list !== -1 && drain > list && ready > drain, "refreshChatList -> drainOpened -> shareInbox.ready");
  assert.match(boot.slice(ready), /visibilitychange[\s\S]*scheduleDrainOpened/);
});

// Minimal DOM for buildSharePicker (the real velta-chat-item is a custom
// element; the picker only needs click listeners on whatever makeItem gives).
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.attrs = {}; this.value = ""; this.textContent = ""; this.className = ""; }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  replaceChildren(...cs) { this.children = []; for (const c of cs) this.appendChild(c); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(n, fn) { (this.listeners[n] ||= []).push(fn); }
  fire(n) { for (const fn of this.listeners[n] || []) fn({ target: this }); }
}
const doc = { createElement: tag => new El(tag) };
const chats = [
  { id: -1, name: "Velta Diagnostics", kind: "device" },
  { id: 10, name: "Alice", kind: "single" },
  { id: 11, name: "Bob", kind: "single" },
  { id: 12, name: "Family", kind: "group" },
  { id: 13, name: "Request", kind: "deaddrop" },
  { id: 14, name: "News", kind: "channel", readOnly: true },
];
const row = chat => { const el = new El("velta-chat-item"); el.chat = chat; return el; };

test("share targets drop device, contact-request and read-only chats; search narrows by name", () => {
  assert.deepEqual(shareTargets(chats).map(c => c.id), [10, 11, 12]);
  assert.deepEqual(shareTargets(chats, "  fam ").map(c => c.id), [12]);
  assert.deepEqual(shareTargets(chats, "zzz"), []);
  assert.deepEqual(shareTargets(null), []);
});

test("the picker really lists the chats (#97: the sheet used to open empty)", () => {
  const picks = [];
  const picker = buildSharePicker(doc, { chats, makeItem: row, onPick: p => picks.push(p) });
  const ids = picker.list.children.map(c => c.chat?.id);
  assert.deepEqual(ids, [10, 11, 12]);
  assert.equal(picker.search.type, "search");
  assert.ok(picker.el.children.includes(picker.list), "list is inside the modal body");
  picker.list.children[1].fire("click");
  assert.deepEqual(picks, [{ chat: chats[2] }]);
  // search
  picker.search.value = "ali";
  picker.search.fire("input");
  assert.deepEqual(picker.list.children.map(c => c.chat?.id), [10]);
  picker.search.value = "nobody";
  picker.search.fire("input");
  assert.equal(picker.list.children.length, 1);
  assert.equal(picker.list.children[0].textContent, "No matching chat.");
});

test("an empty profile says so instead of showing a blank sheet", () => {
  const picker = buildSharePicker(doc, { chats: [chats[0]], makeItem: row, onPick() {} });
  assert.equal(picker.list.children[0].textContent, "No chat to share to.");
});

test("several profiles: a chip per profile, tapping another one asks to switch", () => {
  const picks = [];
  const accounts = [{ id: 1, name: "Work" }, { id: 2, addr: "me@home.example" }];
  const picker = buildSharePicker(doc, { chats, accounts, currentAccountId: 1, makeItem: row, onPick: p => picks.push(p) });
  const bar = picker.el.children.find(c => c.className === "share-accounts");
  assert.ok(bar);
  assert.deepEqual(bar.children.map(b => b.textContent), ["Work", "me@home.example"]);
  assert.equal(bar.children[0].attrs["aria-pressed"], "true");
  bar.children[0].fire("click"); // current profile: no-op
  bar.children[1].fire("click");
  assert.deepEqual(picks, [{ accountId: 2 }]);
  const single = buildSharePicker(doc, { chats, accounts: [accounts[0]], currentAccountId: 1, makeItem: row, onPick() {} });
  assert.equal(single.el.children.some(c => c.className === "share-accounts"), false);
});

test("share plan joins the texts and keeps each file once", () => {
  assert.deepEqual(sharePlan([{ text: "a" }, { file: "content://1" }, { text: "b" }, { file: "content://1" }, { file: "content://2" }, null]),
    { text: "a\n\nb", files: ["content://1", "content://2"] });
  assert.deepEqual(sharePlan([{ text: "" }]), { text: "", files: [] });
});

test("stage kind: text and one photo/video are staged, the rest is sent", () => {
  assert.equal(shareStageKind([]), "text");
  assert.equal(shareStageKind(["/acc/uploads/IMG_1.JPG"]), "image");
  assert.equal(shareStageKind(["C:\\Users\\a\\clip.mp4"]), "video");
  assert.equal(shareStageKind(["/acc/doc.pdf"]), "send");
  assert.equal(shareStageKind(["/acc/logo.svg"]), "send");
  assert.equal(shareStageKind(["/acc/1728550000000"]), "send");
  assert.equal(shareStageKind(["/a.jpg", "/b.jpg"]), "send");
});

test("share inbox holds a cold-start share until ready, then runs bursts one at a time", async () => {
  const runs = [];
  let release;
  const inbox = createShareInbox(async batch => {
    runs.push(batch.map(i => i.text ?? i.file));
    if (runs.length === 1) await new Promise(r => { release = r; });
  });
  inbox.push([{ text: "early" }]);
  inbox.push([{ file: "content://p1" }, null, {}]);
  await new Promise(r => setImmediate(r));
  assert.equal(runs.length, 0, "nothing runs before ready (chat list not loaded)");
  assert.equal(inbox.pending, 2);
  inbox.ready();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(runs, [["early", "content://p1"]], "held items are one burst");
  inbox.push([{ text: "warm" }]); // warm start while the first picker is open
  await new Promise(r => setImmediate(r));
  assert.equal(runs.length, 1, "no second picker on top of the first");
  release();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(runs, [["early", "content://p1"], ["warm"]]);
});

test("a failing share reports and does not block the next one", async () => {
  const errors = [], runs = [];
  const inbox = createShareInbox(async batch => {
    runs.push(batch[0].text);
    if (batch[0].text === "bad") throw new Error("boom");
  }, err => errors.push(err.message));
  inbox.ready();
  await inbox.push([{ text: "bad" }]);
  await inbox.push([{ text: "good" }]);
  assert.deepEqual(runs, ["bad", "good"]);
  assert.deepEqual(errors, ["boom"]);
});

test("a share-sheet launch replayed from Recents is not offered again", () => {
  const kt = readFileSync(new URL("../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/MainActivity.kt", import.meta.url), "utf8");
  const create = kt.slice(kt.indexOf("override fun onCreate"), kt.indexOf("super.onCreate(savedInstanceState)"));
  assert.match(create, /FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY/);
  assert.match(create, /intent = Intent\(Intent\.ACTION_MAIN\)/);
});
