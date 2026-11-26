import test from "node:test";
import assert from "node:assert/strict";
import { installChatViewGlobals, installFakeDocument, installFakeFrames } from "./helpers/fake-dom.mjs";

// #470 on the Tauri desktop build (Pavel, 2026-11-24): a Dash send "did
// nothing", no route line showed, and the error blamed email. The desktop
// attach paths (file dialog, a file dropped on the window, Open with) must
// show the route before Send, every wait must show a busy ring, and a
// failed offer must keep the file staged and say that Dash failed.
installChatViewGlobals();
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...a) => { const h = realSetTimeout(...a); h?.unref?.(); return h; };
const { ChatView } = await import("../app/js/chat-view.js");
const { closeAllPopups } = await import("../app/js/ui.js");

const MB = 1048576;
const BIG = 50 * MB; // over the 22 MB email cap
const enc = (o) => "VXFER1:" + Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
const tick = () => new Promise((r) => setImmediate(r));
async function until(cond, what) {
  for (let i = 0; i < 400; i++) { if (cond()) return; await tick(); }
  assert.fail("timed out waiting for " + what);
}
const textOf = (el) => [el.textContent || "", ...(el.children || []).map(textOf)].join(" ");

// One shell, core and view for the file: the Dash UI module binds once.
const sh = { health: { ready: true, relay: null, relayConnected: false, direct: 1 }, offer: null, calls: [], drop: null, pick: null };
window.__TAURI__ = {
  core: { invoke: async (cmd, args) => {
    sh.calls.push([cmd, args]);
    if (cmd === "xfer_file_size") return /big/.test(args.path) ? BIG : 1000;
    if (cmd === "xfer_health") return typeof sh.health === "function" ? sh.health() : sh.health;
    if (cmd === "xfer_offer") return sh.offer(args);
    if (cmd === "plugin:dialog|open") return sh.pick;
    if (cmd === "resolve_upload_path") return `/acc/uploads/${args.filename}`;
    if (cmd === "stage_upload") return sh.holdStage || `/acc/uploads/${args.filename}`;
    if (cmd === "plugin:fs|read_file" || cmd === "read_media_bytes") return [1, 2, 3];
    return null;
  } },
  event: { listen: async (name, fn) => { if (name === "tauri://drag-drop") sh.drop = fn; return () => {}; } },
};
const node = installFakeDocument();
installFakeFrames();
const sent = [];
const core = Object.assign(new EventTarget(), {
  accountId: "A", accountEpoch: 0,
  getChat: async (id) => ({ id, kind: "single", chatType: "Single", contactId: 12, name: "Kay", unread: 0, encrypted: true }),
  getMessages: async () => ({ messages: [], hasMore: false }),
  markRead: async () => {},
  getConfig: async (k) => (k === "ui.velta.xfer.peer.12" ? "1700000000" : null),
  setConfig: async () => {},
  getServerMetadata: async () => ({}),
  sendMessage: async (chatId, data) => { sent.push({ chatId, ...data }); return { id: 100 + sent.length, chatId }; },
});
const view = new ChatView(core, { onChatsChanged: () => {}, onForward: () => {} });
view._createScroller = function () { this.vs = { stop() {}, setItems() {}, onItemHeightDidChange() {} }; };
view.startLive = () => {};
view.appendOutgoing = () => {};
assert.equal(await view.open(7), true);
test.after(() => { view.close(); closeAllPopups(); window.__TAURI__ = null; });

async function staged(prev = null) {
  await until(() => view.pendingMedia && view.pendingMedia !== prev && view.pendingMedia.planning, "the strip");
  await view.pendingMedia.planning;
  return view.pendingMedia;
}

test("a Dash that does not answer says why before Send instead of a silent wait", async () => {
  let answer = null;
  sh.health = () => new Promise((r) => { answer = r; });
  sh.drop({ payload: { paths: ["/home/p/big-x.bin"] } });
  await until(() => answer, "the health check");
  // While it checks: a busy ring and "Checking how to send…", never a blank strip.
  assert.match(node("media-route").textContent, /50(\.0)? MB · Checking how to send…/);
  assert.equal(node("media-route").classList.contains("is-busy"), true);
  answer({ ready: false, relay: null, relayConnected: false, error: "timeout" });
  const pm = await staged();
  assert.equal(pm.plan.route, "blocked");
  assert.match(node("media-route").textContent, /Can't send: Velta Dash is unavailable \(it is not responding\) and the file is too big for email \(max 22 MB\)/);
  sh.health = { ready: true, relay: null, relayConnected: false, direct: 1 };
  view._clearPendingMedia();
  // Failures are not cached: the next attach checks again (below: healthy).
});

test("a big file dropped on the desktop window stages with its Dash route line", async () => {
  assert.equal(typeof sh.drop, "function", "the window listens for dropped files");
  sh.drop({ payload: { paths: ["/home/p/big-film.bin"], position: { x: 1, y: 1 } } });
  const pm = await staged();
  assert.equal(pm.kind, "file");
  assert.equal(pm.size, BIG);
  const route = node("media-route");
  assert.equal(route.hidden, false);
  assert.match(route.textContent, /50(\.0)? MB · Velta Dash: direct to Kay/);
  assert.equal(route.classList.contains("is-busy"), false, "no ring once the route is known");
  assert.equal(sent.length, 0, "nothing sent before Send");
  view._clearPendingMedia();
});

test("a video pick shows the strip and a spinner while the copy is still running", async () => {
  let release;
  sh.holdStage = new Promise((r) => { release = r; });
  sh.pick = "/home/p/clip.mp4";
  const health = () => sh.calls.filter(([c]) => c === "xfer_health").length;
  const before = health();
  const pending = view._sendAttachment("video");
  await until(() => view.pendingMedia?.staging, "strip during copy");
  assert.equal(node("media-preview").hidden, false);
  assert.equal(node("media-preview-name").textContent, "clip.mp4");
  assert.equal(node("media-preview-thumb").getAttribute("aria-busy"), "true");
  assert.ok(node("media-preview-thumb").querySelector(".mp-spinner"));
  assert.match(node("media-route").textContent, /Preparing file…/);
  assert.equal(node("media-route").classList.contains("is-busy"), true);
  assert.equal(health(), before, "Dash route check waits until the file is staged");
  release("/acc/uploads/1-clip.mp4");
  sh.holdStage = null;
  await pending;
  await view.pendingMedia.planning;
  assert.equal(view.pendingMedia.corePath, "/acc/uploads/1-clip.mp4");
  assert.equal(view.pendingMedia.staging, null);
  assert.ok(node("media-preview-thumb").querySelector(".mp-video"));
  view._clearPendingMedia();
});

test("the desktop file dialog stages a big file with its route line too", async () => {
  sh.pick = "/home/p/big-backup.bin";
  await view._sendAttachment("file");
  const pm = await staged();
  assert.equal(pm.size, BIG);
  assert.match(node("media-route").textContent, /Velta Dash: direct to Kay/);
  view._clearPendingMedia();
});

test("Send is busy while the offer is prepared; a failed offer keeps the file and says Dash failed", async () => {
  sh.drop({ payload: { paths: ["/home/p/big-movie.bin"] } });
  const pm = await staged();
  let release;
  sh.offer = () => new Promise((res, rej) => { release = { res, rej }; });
  const offers = () => sh.calls.filter(([c]) => c === "xfer_offer").length;
  const before = offers();
  const sending = view._send();
  await until(() => offers() > before, "xfer_offer");
  const btn = node("btn-send");
  assert.equal(btn.classList.contains("is-busy"), true, "Send shows the busy ring");
  assert.equal(btn.getAttribute("aria-busy"), "true");
  assert.match(node("media-route").textContent, /Preparing for Velta Dash…/);
  assert.equal(node("media-route").classList.contains("is-busy"), true);
  assert.equal(view.pendingMedia, pm, "the strip stays while the offer runs");
  await view._send();
  assert.equal(offers(), before + 1, "a second tap does not send twice");
  release.rej(new Error("disk full"));
  await sending;
  assert.equal(view.pendingMedia, pm, "still staged: nothing went out");
  assert.equal(btn.classList.contains("is-busy"), false);
  assert.equal(btn.getAttribute("aria-busy"), null);
  assert.doesNotMatch(node("media-route").textContent, /Preparing/);
  assert.equal(sent.length, 0);
  assert.match(textOf(node("toasts")), /Velta Dash couldn't prepare the file \(disk full\), and it is too big for email \(max 22 MB\)\. Nothing was sent\./);
});

test("a ready offer mails the Dash card and clears the strip", async () => {
  const pm = view.pendingMedia;
  assert.ok(pm, "the file from the failed send is still staged");
  sh.offer = async (args) => enc({ v: 1, proto: "iroh-0.35", node: "ab".repeat(32), relay: null, addrs: [], hash: "cd".repeat(32), size: BIG, name: args.name, exp: 4000000000, sec: "00" });
  await view._send();
  assert.equal(view.pendingMedia, null);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /VXFER1:/);
  assert.equal(node("btn-send").classList.contains("is-busy"), false);
});

test("pasted videos and photos show their route line too", async () => {
  const realURL = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:velta/x";
  URL.revokeObjectURL = () => {};
  try {
    for (const [type, name, kind] of [["video/mp4", "clip.mp4", "video"], ["image/png", "shot.png", "image"]]) {
      const prev = view.pendingMedia;
      const file = { size: BIG, type, name };
      await node("composer-input").fire("paste", {
        preventDefault() {},
        clipboardData: { items: [{ kind: "file", type, getAsFile: () => file }], files: [], getData: () => "" },
      });
      const pm = await staged(prev);
      assert.equal(pm.kind, kind);
      assert.equal(pm.size, BIG);
      assert.match(node("media-route").textContent, /50(\.0)? MB · Velta Dash: direct to Kay/, `${kind} paste`);
      view._clearPendingMedia();
    }
  } finally { URL.createObjectURL = realURL; URL.revokeObjectURL = realRevoke; }
});

test("a dropped big video gets its size and route line from the shell", async () => {
  const prev = view.pendingMedia;
  sh.drop({ payload: { paths: ["/home/p/big-trip.mkv"] } });
  const pm = await staged(prev);
  assert.equal(pm.kind, "video");
  assert.equal(pm.size, BIG, "size read via xfer_file_size, the video is never loaded");
  assert.match(node("media-route").textContent, /50(\.0)? MB · Velta Dash: direct to Kay/);
  view._clearPendingMedia();
});
