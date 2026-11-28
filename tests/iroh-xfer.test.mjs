// #470: policy and message formats of the automatic iroh file transfer.
// The transfer itself is tested in velta-app/src-tauri/src/xfer.rs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  THRESHOLD, chooseRoute, irohXferEnabled, setIrohXferEnabled, advertisedRelay, decodeTicket,
  fileCardText, parseFileCard, resendRequestText, parseResendRequest, createTransport, EMAIL_MAX, DELIVERED_GRACE_MS,
  dashState, dashExplainer, emailReason, routeLabel, SETTING_LABEL,
  xferDisplayText, xferVisibleText, looksLikeXferExplainer,
} from "../app/js/iroh-xfer.js";

const tk = { v: 1, proto: "iroh-0.35", node: "ab".repeat(32), relay: "https://iroh.relay.example/", addrs: [], hash: "cd".repeat(32), size: 7000000, name: "Фильм.mp4", exp: 4000000000 };
const enc = (o) => "VXFER1:" + Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

test("route: only 1:1, Velta peer, over 6 MB, setting on, Tauri", () => {
  const base = { size: THRESHOLD + 1, oneToOne: true, peerIsVelta: true, enabled: true, available: true };
  assert.equal(chooseRoute(base), "iroh");
  assert.equal(chooseRoute({ ...base, size: THRESHOLD }), "email", "6 MB or less: email");
  assert.equal(chooseRoute({ ...base, peerIsVelta: false }), "email", "Delta Chat contact: email");
  assert.equal(chooseRoute({ ...base, oneToOne: false }), "email");
  assert.equal(chooseRoute({ ...base, enabled: false }), "email");
  assert.equal(chooseRoute({ ...base, available: false }), "email", "PWA: email");
});

test("setting is on by default and can be turned off", () => {
  const m = new Map(); const s = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  assert.equal(irohXferEnabled(s), true);
  setIrohXferEnabled(false, s); assert.equal(irohXferEnabled(s), false);
  setIrohXferEnabled(true, s); assert.equal(irohXferEnabled(s), true);
});

test("relay: only the chatmail relay's advertised https iroh relay, else none", () => {
  // get_server_metadata answers camelCase over JSON-RPC (irohRelay).
  assert.equal(advertisedRelay({ "a@one.example": { irohRelay: "https://iroh.one.example/" } }), "https://iroh.one.example/");
  assert.equal(advertisedRelay({ "a@one.example": { irohRelay: null } }), null);
  const md = { "a@one.example": { iroh_relay: "https://iroh.one.example/" }, "b@two.example": { iroh_relay: null } };
  assert.equal(advertisedRelay(md, "a@one.example"), "https://iroh.one.example/");
  assert.equal(advertisedRelay(md, "b@two.example"), null);
  assert.equal(advertisedRelay(md), "https://iroh.one.example/");
  assert.equal(advertisedRelay({ x: { iroh_relay: "http://plain/" } }), null);
  assert.equal(advertisedRelay(null), null);
});

test("file card carries a readable line and the ticket (UTF-8 names)", () => {
  const ticket = enc(tk);
  assert.deepEqual(decodeTicket(ticket), tk);
  const text = fileCardText({ name: tk.name, size: tk.size, ticket });
  const lines = text.split("\n");
  assert.match(lines[0], /📦 Фильм\.mp4 \(6\.7 MB\) was sent with Velta Dash/);
  assert.match(lines[0], /files up to 2 GB straight between Velta apps/);
  assert.match(lines[1], /learn more at https:\/\/velta\.cc\/dash/);
  assert.equal(lines[2], ticket);
  const card = parseFileCard(text);
  assert.equal(card.ticket, ticket);
  assert.equal(card.size, tk.size);
  assert.equal(card.name, tk.name);
  assert.equal(parseFileCard("hello"), null);
  assert.equal(decodeTicket(enc({ ...tk, hash: "x" })), null);
  assert.equal(decodeTicket(enc({ ...tk, v: 2 })), null);
});

test("resend request round-trips and rejects junk", () => {
  assert.equal(parseResendRequest(resendRequestText(tk.hash)), tk.hash);
  assert.equal(parseResendRequest("VXFER-RESEND:zz"), null);
});

test("transport: big 1:1 Velta file goes as a ticket card, fetched over iroh", async () => {
  const { createTransport } = await import("../app/js/iroh-xfer.js");
  const log = [];
  const ticket = enc(tk);
  const email = { sendFile: async (c, f) => log.push(["mail-file", c, f.name]), sendText: async (c, t) => log.push(["mail-text", c, t]) };
  const iroh = { offer: async (p, r) => { log.push(["offer", p, r]); return ticket; }, fetch: async () => ({ path: "/acc/xfer-in/x" }), withdraw: async (h) => log.push(["withdraw", h]) };
  const tr = createTransport({ email, iroh, relay: async () => "https://iroh.one.example/", enabled: () => true });
  const r = await tr.send({ chatId: 5, file: { name: "big.mp4", size: THRESHOLD + 10, path: "/tmp/big.mp4" }, oneToOne: true, peerIsVelta: true });
  assert.equal(r.route, "iroh");
  assert.deepEqual(log[0], ["offer", "/tmp/big.mp4", "https://iroh.one.example/"]);
  assert.equal(log[1][0], "mail-text");
  assert.ok(log[1][2].endsWith(ticket));
  assert.ok(tr.pending.has(tk.hash));
  const got = await tr.receive({ chatId: 5, text: log[1][2] });
  assert.deepEqual(got, { route: "iroh", path: "/acc/xfer-in/x" });
  const small = await tr.send({ chatId: 5, file: { name: "s.jpg", size: 100, path: "/tmp/s" }, oneToOne: true, peerIsVelta: true });
  assert.equal(small.route, "email");
  assert.deepEqual(log.at(-1), ["mail-file", 5, "s.jpg"]);
});

test("transport: expired/unreachable fetch asks for the email copy; sender mails it once", async () => {
  const { createTransport } = await import("../app/js/iroh-xfer.js");
  const ticket = enc(tk);
  const sentA = [], sentB = [];
  const a = createTransport({ enabled: () => true,
    email: { sendFile: async (c, f) => sentA.push(["file", f.name]), sendText: async (c, t) => sentA.push(["text", t]) },
    iroh: { offer: async () => ticket, withdraw: async (h) => sentA.push(["withdraw", h]) } });
  const b = createTransport({ enabled: () => true,
    email: { sendFile: async () => {}, sendText: async (c, t) => sentB.push(t) },
    iroh: { fetch: async () => ({ error: "Expired", email: true }) } });
  await a.send({ chatId: 1, file: { name: "v.mkv", size: THRESHOLD * 2, path: "/v" }, oneToOne: true, peerIsVelta: true });
  assert.equal(sentA[0][0], "text", "offered: the card is mailed, not the file");
  const r = await b.receive({ chatId: 1, text: sentA[0][1] });
  assert.equal(r.asked, true);
  assert.equal(sentB[0], resendRequestText(tk.hash));
  assert.deepEqual(await a.onResendRequest({ text: sentB[0], chatId: 1 }), { name: "v.mkv", chatId: 1 }, "mails the pending file");
  assert.deepEqual(sentA.slice(1), [["file", "v.mkv"], ["withdraw", tk.hash]]);
  assert.equal(await a.onResendRequest({ text: sentB[0], chatId: 1 }), null, "only once");
  const c = createTransport({ enabled: () => true, email: { sendFile: async () => {}, sendText: async () => {} }, iroh: { fetch: async () => ({ error: "Io(reset)", email: false }) } });
  assert.equal((await c.receive({ chatId: 1, text: sentA[0][1] })).retry, true, "broken stream: resume over iroh, no email");
});

test("transport reports why a file went by email (diagnostics glue)", async () => {
  const { createTransport } = await import("../app/js/iroh-xfer.js");
  const mailed = [];
  const t = createTransport({ enabled: () => false,
    email: { sendFile: async (c, f) => mailed.push(f.name), sendText: async () => {} }, iroh: null });
  const off = await t.send({ chatId: 1, file: { name: "a.bin", size: THRESHOLD + 1, path: "/a" }, oneToOne: true, peerIsVelta: true });
  assert.equal(off.route, "email");
  assert.equal(off.via, "policy");
  const t2 = createTransport({ enabled: () => true,
    email: { sendFile: async (c, f) => mailed.push(f.name), sendText: async () => {} },
    iroh: { offer: async () => { throw new Error("endpoint down"); } } });
  const bad = await t2.send({ chatId: 1, file: { name: "b.bin", size: THRESHOLD + 1, path: "/b" }, oneToOne: true, peerIsVelta: true });
  assert.equal(bad.route, "email");
  assert.equal(bad.via, "offer-failed");
  assert.match(String(bad.error), /endpoint down/);
  assert.deepEqual(mailed, ["a.bin", "b.bin"]);
});

const memStore = () => { let v = {}; return { load: () => JSON.parse(JSON.stringify(v)), save: (o) => { v = JSON.parse(JSON.stringify(o)); }, peek: () => v }; };
const offerOf = (o = {}) => enc({ ...tk, sec: "s".repeat(32), ...o });

test("pending offers survive a restart; resend honoured only from the chat or Saved Messages", async () => {
  const store = memStore();
  const log = [];
  const iroh = {
    offer: async () => offerOf(),
    withdraw: async (h) => log.push(["withdraw", h]),
    status: async (hs) => Object.fromEntries(hs.map((h) => [h, { size: tk.size, exp: tk.exp, delivered: false, path: "/xfer/out/" + h }])),
  };
  const email = { sendFile: async (c, f) => log.push(["file", c, f.path, f.name]), sendText: async () => {} };
  const a = createTransport({ email, iroh, store, enabled: () => true });
  await a.send({ chatId: 7, file: { name: "film.mkv", size: tk.size, path: "/uploads/u1" }, oneToOne: true, peerIsVelta: true });
  assert.ok(store.peek()[tk.hash], "persisted on offer");

  const b = createTransport({ email, iroh, store, enabled: () => true }); // app restarted
  assert.ok(b.pending.has(tk.hash));
  const req = resendRequestText(tk.hash);
  assert.equal(await b.onResendRequest({ text: req, chatId: 99, selfChatId: 3 }), null, "a stranger's chat cannot pull the file");
  assert.deepEqual(await b.onResendRequest({ text: req, chatId: 3, selfChatId: 3 }), { name: "film.mkv", chatId: 3 }, "own other device: mailed to Saved Messages");
  assert.ok(b.pending.has(tk.hash), "the peer can still fetch or ask");
  assert.equal(await b.onResendRequest({ text: req, chatId: 3, selfChatId: 3 }), null, "Saved Messages copy goes once");
  assert.deepEqual(await b.onResendRequest({ text: req, chatId: 7, selfChatId: 3 }), { name: "film.mkv", chatId: 7 });
  assert.deepEqual(log, [
    ["file", 3, `/xfer/out/${tk.hash}`, "film.mkv"],
    ["file", 7, `/xfer/out/${tk.hash}`, "film.mkv"],
    ["withdraw", tk.hash],
  ], "the stored copy is mailed under the original name, then withdrawn");
  assert.equal(b.pending.size, 0);
  assert.deepEqual(store.peek(), {}, "cleared on disk too");
});

test("sweep: expired offers go by email, delivered ones are withdrawn after the grace, too-big ones error", async () => {
  let clock = 1_000_000_000_000;
  const H = (c) => c.repeat(64);
  const store = memStore();
  const nowS = clock / 1000;
  store.save({
    [H("1")]: { chatId: 1, name: "late.bin", size: 10_000_000, exp: nowS - 1, path: "/u/late" },
    [H("2")]: { chatId: 2, name: "got.bin", size: 10_000_000, exp: nowS + 3600 * 24, path: "/u/got" },
    [H("3")]: { chatId: 3, name: "huge.bin", size: EMAIL_MAX + 1, exp: nowS - 1, path: "/u/huge" },
    [H("4")]: { chatId: 4, name: "gone.bin", size: 10_000_000, exp: nowS + 60, path: "/u/gone" },
    [H("5")]: { chatId: 5, name: "open.bin", size: 10_000_000, exp: nowS + 2 * 86400, path: "/u/open" },
  });
  const mailed = [], withdrawn = [];
  const status = {
    [H("1")]: { delivered: false, path: "/x/out/1" }, [H("2")]: { delivered: true, path: "/x/out/2" },
    [H("3")]: { delivered: false, path: "/x/out/3" }, [H("4")]: null, [H("5")]: { delivered: false, path: "/x/out/5" },
  };
  const tr = createTransport({ store, now: () => clock,
    email: { sendFile: async (c, f) => mailed.push([c, f.path, f.name]), sendText: async () => {} },
    iroh: { status: async (hs) => Object.fromEntries(hs.map((h) => [h, status[h]])), withdraw: async (h) => withdrawn.push(h[0]) } });
  const ev1 = await tr.sweep();
  assert.deepEqual(ev1.map((e) => [e.name, e.action]).sort(), [["gone.bin", "missing"], ["huge.bin", "too-big"], ["late.bin", "mailed"]]);
  assert.deepEqual(mailed, [[1, "/x/out/1", "late.bin"]], "only the expired, undelivered, mailable one");
  assert.deepEqual(withdrawn.sort(), ["1", "3", "4"]);
  assert.deepEqual(Object.keys(store.peek()).sort(), [H("2"), H("5")]);
  clock += DELIVERED_GRACE_MS;
  const ev2 = await tr.sweep();
  assert.deepEqual(ev2.map((e) => [e.name, e.action]), [["got.bin", "withdrawn"]], "delivered: withdrawn once the receiver's devices had an hour");
  assert.deepEqual(Object.keys(store.peek()), [H("5")], "an undelivered, unexpired offer stays");
});

test("PWA receiver (no iroh) asks for the email copy at once", async () => {
  const sent = [];
  const tr = createTransport({ email: { sendFile: async () => {}, sendText: async (c, t) => sent.push([c, t]) }, iroh: null });
  const r = await tr.receive({ chatId: 4, text: fileCardText({ name: "a.bin", size: tk.size, ticket: offerOf() }) });
  assert.equal(r.asked, true);
  assert.deepEqual(sent, [[4, resendRequestText(tk.hash)]]);
});

function fakeCore(config = {}) {
  const core = new EventTarget();
  core.accountId = 1;
  core.config = { ...config };
  core.getConfig = async (k) => core.config[k] ?? null;
  core.setConfig = async (k, v) => { core.config[k] = v; };
  core.getChat = async (id) => ({ id, chatType: "Single", contactId: 12, isContactRequest: false });
  core.createChatByContactId = async (id) => (id === 1 ? 3 : 100 + id);
  core.msg = (chatId, text, out = false) => core.dispatchEvent(Object.assign(new Event("incoming-msg"), { detail: { chatId, msg: { chatId, text, from: out ? 1 : 0 } } }));
  return core;
}
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

test("ui glue (Tauri): capability announce, proven peers only, events, own-device ask", async () => {
  const diag = [];
  globalThis.window = Object.assign(new EventTarget(), { __veltaDiagnostics: { append: (lvl, text) => diag.push(text) } });
  const ui = await import("../app/js/iroh-xfer-ui.js?tauri");
  const core = fakeCore({ "ui.velta.xfer.peer.12": "1700000000" });
  const texts = [], files = [], calls = [];
  const fetches = { [H2("aa")]: { path: "/acc/xfer-in/got.bin" }, [H2("bb")]: { error: "no space", code: "no-space", email: false },
    [H2("cc")]: { path: "/acc/xfer-in/clip.mp4" }, [H2("dd")]: { path: "/acc/xfer-in/shot.png" } };
  function H2(c) { return c.repeat(32); }
  ui.initXferUi({
    core,
    invoke: async (cmd, args) => {
      calls.push(cmd);
      if (cmd === "xfer_offer") return offerOf({ hash: H2("cd"), name: args.name });
      if (cmd === "xfer_fetch") return fetches[decodeTicket(args.ticket).hash];
      if (cmd === "xfer_status") return {};
      return null;
    },
    sendText: async (chatId, text) => { texts.push({ chatId, text }); return { id: texts.length }; },
    sendFile: async (chatId, path, name) => files.push({ chatId, path, name }),
    metadata: async () => ({ "me@relay.example": { irohRelay: "https://iroh.relay.example/" } }),
  });
  await tick();
  assert.equal(core.config["ui.velta.xfer"], "1", "this device announces the transfer (core patch #31 adds the header)");

  // Unknown contact (or Delta Chat): normal attachment, even on the same relay.
  assert.equal((await ui.maybeSend({ chatId: 5, path: "/f", name: "f.bin", size: THRESHOLD + 1, oneToOne: true, contactId: 13 })).handled, false);
  assert.match(diag.at(-1), /iroh xfer: sent f\.bin .* by email: contact has not proved Velta Dash yet/, "#489 diagnostics say why it fell back");
  // Turning Dash off in the drawer re-announces "0" (core drops the header).
  globalThis.localStorage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  localStorage.setItem("velta-iroh-xfer", "0");
  window.dispatchEvent(new Event("velta-dash"));
  await tick();
  assert.equal(core.config["ui.velta.xfer"], "0");
  assert.equal((await ui.maybeSend({ chatId: 6, path: "/f", name: "g.bin", size: THRESHOLD + 1, oneToOne: true, contactId: 12 })).handled, false);
  assert.match(diag.at(-1), /by email: Velta Dash is off/);
  localStorage.removeItem("velta-iroh-xfer");
  window.dispatchEvent(new Event("velta-dash"));
  await tick();
  assert.equal(core.config["ui.velta.xfer"], "1");
  assert.equal(await ui.peerCanXfer(12), true);
  const out = await ui.maybeSend({ chatId: 6, path: "/dl/big.bin", name: "big.bin", size: THRESHOLD + 1, oneToOne: true, contactId: 12 });
  assert.equal(out.handled, true);
  assert.match(texts[0].text, /^VXFER1:/m);
  const stored = JSON.parse(localStorage.getItem("velta-xfer-cards:1") || "{}");
  assert.equal(stored[H2("cd")]?.path, "/dl/big.bin", "the sender's staged path persists for the outgoing preview");
  ui.noteCard(6, texts[0].text, true);
  assert.match(ui.xferCardHtml(texts[0].text), /Sent with Velta Dash/);
  assert.match(ui.xferCardHtml(texts[0].text), /class="xfer-route" data-route="dash"/, "card badge: the path taken");
  assert.doesNotMatch(ui.xferCardHtml(texts[0].text), /xfer-ask/, "the sending device has the file: no ask button");

  // A card arriving while its chat is closed is fetched from the core event.
  const got = fileCardText({ name: "got.bin", size: tk.size, ticket: offerOf({ hash: H2("aa"), name: "got.bin" }) });
  core.msg(9, got);
  await tick();
  assert.match(ui.xferCardHtml(got), /Received with Velta Dash/);
  assert.match(ui.xferCardHtml(got), /xfer-open/);
  assert.match(ui.xferCardHtml(got), /data-route="dash"/);
  ui.noteCard(9, got, false);
  assert.equal(calls.filter((c) => c === "xfer_fetch").length, 1, "rendering again does not fetch twice");

  // Fetched image/video cards lead with a preview frame and open in the
  // lightbox — never a browser window (documents keep the Open anchor).
  const clip = fileCardText({ name: "clip.mp4", size: tk.size, ticket: offerOf({ hash: H2("cc"), name: "clip.mp4" }) });
  core.msg(9, clip);
  await tick();
  assert.match(ui.xferCardHtml(clip), /xfer-preview-btn/, "fetched video leads with a preview frame");
  assert.match(ui.xferCardHtml(clip), /<video class="xfer-preview"/, "video previews via preload=metadata");
  assert.match(ui.xferCardHtml(clip), /data-xfer-view/, "the preview opens the lightbox");
  assert.doesNotMatch(ui.xferCardHtml(clip), /target="_blank"/, "media never escapes to the browser");
  const shot = fileCardText({ name: "shot.png", size: tk.size, ticket: offerOf({ hash: H2("dd"), name: "shot.png" }) });
  core.msg(9, shot);
  await tick();
  assert.match(ui.xferCardHtml(shot), /<img class="xfer-preview"/, "fetched image previews");
  assert.match(ui.xferCardHtml(shot), /data-xfer-view="d{64}"/);
  assert.doesNotMatch(ui.xferCardHtml(clip), /Play video/, "#519: the poster is the open control, no caption pill");
  assert.doesNotMatch(ui.xferCardHtml(shot), /Open image/, "#519: the picture is the open control");
  assert.match(ui.xferCardHtml(clip), /Show in folder/, "desktop: reveal the file");
  // #519: Open is a button (an action, not navigation) with the URL computed
  // at click time from cardState — never an href in the bubble.
  assert.match(ui.xferCardHtml(got), /<button type="button" class="xfer-open btn-text" data-xfer-open="/, "documents keep Open, as a button");
  assert.doesNotMatch(ui.xferCardHtml(got), /a class="xfer-open"/, "no anchor, no href");
  assert.doesNotMatch(ui.xferCardHtml(got), /href=/, "the media URL is never in the DOM");
  // A media ticket with no local bytes (the sender's other device, or before
  // the fetch) shows the placeholder tile instead of staying silent — never
  // an empty preview src. Documents keep the file-type glyph.
  const ghost = fileCardText({ name: "ghost.mp4", size: tk.size, ticket: offerOf({ hash: H2("ff"), name: "ghost.mp4" }) });
  ui.noteCard(6, ghost, true);
  const ghostHtml = ui.xferCardHtml(ghost);
  assert.match(ghostHtml, /xfer-glyph/, "no bytes: the small kind tile instead of a broken-looking block");
  assert.match(ghostHtml, /data-xfer-open|data-xfer-ask/, "the action still offers the email copy");
  assert.doesNotMatch(ghostHtml, /xfer-preview-dead/, "#519 feedback: no big dead tile");
  assert.doesNotMatch(ghostHtml, /Preview unavailable/);
  assert.doesNotMatch(ghostHtml, /src=""/, "never an empty src");

  // No free space: a clear error, and no email request (the disk is the problem).
  const full = fileCardText({ name: "full.bin", size: tk.size, ticket: offerOf({ hash: H2("bb"), name: "full.bin" }) });
  core.msg(9, full);
  await tick();
  assert.match(ui.xferCardHtml(full), /Not enough free space/);
  assert.match(ui.xferCardHtml(full), /is-error/, "#519: an ERRORS sentence gets the wrap class");
  assert.match(ui.xferCardHtml(full), /class="xfer-foot"/, "the error lives on the timestamp row, out of the icon grid");
  assert.equal(texts.filter((x) => /VXFER-RESEND/.test(x.text)).length, 0);

  // The sender's other device sees the outgoing card without a copy: the
  // ask goes to Saved Messages (chat 3), where the device with the offer
  // answers it from the core event.
  const mine = fileCardText({ name: "other.bin", size: tk.size, ticket: offerOf({ hash: H2("ee"), name: "other.bin" }) });
  ui.noteCard(6, mine, true);
  assert.match(ui.xferCardHtml(mine), /xfer-ask/);
  await ui.askForEmailCopy(H2("ee"));
  assert.deepEqual(texts.at(-1), { chatId: 3, text: resendRequestText(H2("ee")) });
  assert.match(ui.xferCardHtml(mine), /Asked for the email copy/);
  assert.match(ui.xferCardHtml(mine), /data-route="email"[^>]*>.*Email fallback/, "card badge: email fallback");

  // A big file on the other device can't travel by email (the cap) — the
  // ask must hide, not invite a doomed request (#519 feedback).
  const bigMine = fileCardText({ name: "huge-other.mp4", size: EMAIL_MAX + 1, ticket: offerOf({ hash: H2("77"), name: "huge-other.mp4", size: EMAIL_MAX + 1 }) });
  ui.noteCard(6, bigMine, true);
  assert.doesNotMatch(ui.xferCardHtml(bigMine), /data-xfer-ask/, "> the email cap: no doomed ask");

  // This device holds big.bin's offer: a request for it from Saved Messages
  // (its own other device, an outgoing message there) mails it there.
  core.msg(3, resendRequestText(H2("cd")), true);
  await tick();
  assert.deepEqual(files, [{ chatId: 3, path: "/dl/big.bin", name: "big.bin" }]);
  core.msg(77, resendRequestText(H2("cd")));
  await tick();
  assert.equal(files.length, 1, "another chat's request is ignored");
  core.msg(6, resendRequestText(H2("cd")));
  await tick();
  assert.deepEqual(files.at(-1), { chatId: 6, path: "/dl/big.bin", name: "big.bin" }, "the peer's request mails it to the chat");
  assert.ok(calls.includes("xfer_withdraw"));
});

test("ui glue (PWA): no iroh — cards ask for the email copy, nothing is offered", async () => {
  const ui = await import("../app/js/iroh-xfer-ui.js?pwa");
  const core = fakeCore({ "ui.velta.xfer.peer.12": "1" });
  const texts = [];
  ui.initXferUi({ core, invoke: null, sendText: async (chatId, text) => texts.push({ chatId, text }), sendFile: async () => {} });
  await tick();
  assert.equal(core.config["ui.velta.xfer"], undefined, "the PWA never announces the capability");
  assert.equal((await ui.maybeSend({ chatId: 6, path: "/f", name: "f", size: THRESHOLD + 1, oneToOne: true, contactId: 12 })).handled, false);
  const card = fileCardText({ name: "p.bin", size: tk.size, ticket: offerOf({ hash: "12".repeat(32), name: "p.bin" }) });
  core.msg(8, card);
  await tick();
  assert.deepEqual(texts, [], "nothing is sent into the chat on arrival");
  assert.match(ui.xferCardHtml(card), /data-xfer-download/, "the card waits for a tap");
  ui.downloadCard("12".repeat(32));
  await tick();
  assert.deepEqual(texts, [{ chatId: 8, text: resendRequestText("12".repeat(32)) }], "requested after the tap");
  assert.match(ui.xferCardHtml(card), /Asked for the email copy/);
  const old = fileCardText({ name: "o.bin", size: tk.size, ticket: offerOf({ hash: "34".repeat(32), name: "o.bin", exp: 1000 }) });
  core.msg(8, old);
  await tick();
  assert.equal(texts.length, 1, "expired cards: the sender mails those itself");
  assert.match(ui.xferCardHtml(old), /xfer-ask/, "manual ask still available");
});

test("Velta Dash: brand strings, header badge state, explainer hint, fallback reasons", () => {
  assert.equal(SETTING_LABEL(), "Velta Dash");
  assert.equal(routeLabel("iroh"), "Sent with Velta Dash");
  assert.match(fileCardText({ name: "a.bin", size: tk.size, ticket: "VXFER1:x" }).split("\n")[0], /a\.bin \(6\.7 MB\) was sent with Velta Dash/);
  const one = { kind: "single", isP2p: false, contactId: 12, shell: true, enabled: true, proven: true };
  assert.equal(dashState(one), "on", "badge: 1:1, Dash on, capability proven");
  assert.equal(dashState({ ...one, proven: false }), "waiting", "unproven (or Delta Chat): no badge");
  assert.equal(dashState({ ...one, enabled: false }), "off");
  assert.equal(dashState({ ...one, kind: "group" }), null, "never in groups");
  assert.equal(dashState({ ...one, contactId: 1 }), null, "not in Saved Messages");
  assert.equal(dashState({ ...one, isP2p: true }), null, "not in local (Loop) chats");
  assert.equal(dashState({ ...one, shell: false }), null, "not in the PWA");
  assert.match(dashExplainer("on"), /files over 6 MB go directly between devices, with email as a fallback/);
  assert.match(dashExplainer("waiting"), /Dash starts after you both exchange a message/);
  const big = { size: THRESHOLD + 1, oneToOne: true, proven: true, enabled: true, available: true };
  assert.equal(emailReason(big), null);
  assert.equal(emailReason({ ...big, size: 10 }), null, "small files: no log line");
  assert.match(emailReason({ ...big, proven: false }), /not proved/);
  assert.match(emailReason({ ...big, enabled: false }), /off/);
  assert.match(emailReason({ ...big, oneToOne: false }), /1:1/);
  assert.match(emailReason({ ...big, available: false }), /PWA/);
});

test("Velta Dash icon: the brand mark is the site logo byte-exact; P.dash stays the outline KMP glyph", async () => {
  const { P, ICON, DASH_SVG } = await import("../app/js/icons.js");
  assert.ok(P.dash && P.dash !== P.loop);
  assert.doesNotMatch(P.dash, /fill="currentColor"/);
  assert.match(ICON.dash, /aria-hidden="true"/);
  // The UI brand mark is velta.cc/dash-logo.svg verbatim (viewBox + all six
  // filled paths of the user-fixed geometry).
  assert.match(DASH_SVG, /viewBox="0 0 277 260"/);
  for (const d of [
    "M0 0H79.5L177 187L139.5 260L0 0Z",
    "M207.971 131H165.276L148.5 97H225.757L207.971 131Z",
    "M186 173L165.276 131H207.971L186 173Z",
    "M265.515 21H186.5L197 0H276.5L265.515 21Z",
    "M245.636 59H167.5L177 40H255.575L245.636 59Z",
    "M225.757 97H148.5L158 78H235.696L225.757 97Z",
  ]) assert.ok(DASH_SVG.includes(`d="${d}"`), `mark path ${d}`);
  assert.match(DASH_SVG, /fill="currentColor"/);
  assert.match(DASH_SVG, /aria-hidden="true"/);
});

test("the state line lives OUTSIDE [data-xfer]; paintCard resolves it through the parent", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../app/js/iroh-xfer-ui.js", import.meta.url), "utf8");
  // .xfer-foot is a sibling of the card (it spans the bubble and carries the
  // timestamp). Querying .xfer-state inside [data-xfer] finds nothing, and
  // live updates silently never land — the "stuck Waiting for sender…" bug.
  assert.match(src, /card\.parentElement\?\.querySelector\(":scope > \.xfer-foot"\)/, "state line resolved beside the card, not inside it");
  const ui = await import("../app/js/iroh-xfer-ui.js?foot");
  const card = fileCardText({ name: "d.bin", size: tk.size, ticket: offerOf({ hash: "0e".repeat(32), name: "d.bin" }) });
  const html = ui.xferCardHtml(card) || "";
  const cardEnd = html.indexOf("</span>", html.indexOf("xfer-sub"));
  assert.ok(html.indexOf('class="xfer-foot"') > cardEnd, "the foot renders after the [data-xfer] span closes");
});

test("Velta Dash header badge: hidden by default, labelled, icon-only accent like #btn-call; drawer toggle is branded", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  const btn = /<button[^>]*id="btn-dash"[^>]*>/.exec(html)?.[0] || "";
  assert.match(btn, /\bhidden\b/);
  assert.match(btn, /aria-label="Velta Dash is on with this contact"/);
  assert.match(btn, /data-i18n-label="Velta Dash is on with this contact"/);
  assert.match(html, /id="btn-dash"[\s\S]*?data-icon="dash"/);
  assert.doesNotMatch(html, /dash-pill/, "icon-only: no pill wrapper, no text");
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  const rule = /\.dash-badge \{[^}]*\}/.exec(css)?.[0] || "";
  assert.match(rule, /width: 40px/);
  assert.match(rule, /height: 40px/);
  assert.match(rule, /color: var\(--accent-text\)/, "accent ink is the on signal");
  assert.doesNotMatch(css, /dash-pill/);
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /data-setting="dash">\$\{DASH_SVG\}/);
  assert.match(ui, /toggleText\("Velta Dash"/);
  assert.match(ui, /new CustomEvent\("velta-dash"/);
  assert.doesNotMatch(ui, /Send large files directly/);
});

// --- #470 phone test (two Android phones, 4G): routes, caps, card states ---

test("pre-send route: Dash when it can deliver, email under the cap, blocked over it", async () => {
  const { planRoute, routeText, peerDomains } = await import("../app/js/iroh-xfer.js");
  const big = THRESHOLD + 1, huge = EMAIL_MAX + 1;
  const ok = { oneToOne: true, proven: true, enabled: true, available: true };
  const up = { ready: true, relay: "https://relay.example/", relayConnected: true };
  const down = { ready: true, relay: "https://relay.example/", relayConnected: false };
  assert.equal(planRoute({ ...ok, size: huge, health: up }).route, "dash");
  assert.equal(routeText(planRoute({ ...ok, size: huge, health: up }), "K"), "Velta Dash: direct to K");
  // Relay not reachable from this phone: a receiver on 4G could not dial us.
  assert.deepEqual(planRoute({ ...ok, size: big, health: down }), { route: "email", reason: "dash-down", why: "relay" });
  assert.equal(routeText(planRoute({ ...ok, size: big, health: down })), "Velta Dash is unavailable (it can't reach your Dash relay): sending by email (max 22 MB)");
  assert.deepEqual(planRoute({ ...ok, size: huge, health: down }), { route: "blocked", reason: "dash-down-too-big", why: "relay" });
  assert.equal(routeText(planRoute({ ...ok, size: huge, health: down })), "Can't send: Velta Dash is unavailable (it can't reach your Dash relay) and the file is too big for email (max 22 MB)");
  assert.equal(planRoute({ ...ok, size: huge, health: { ready: false } }).route, "blocked", "endpoint down");
  // The line says why Dash is down, never just "too big for email".
  assert.match(routeText(planRoute({ ...ok, size: huge, health: { ready: false, error: "timeout" } })), /\(it is not responding\)/);
  assert.match(routeText(planRoute({ ...ok, size: huge, health: { ready: false, error: "no key" } })), /\(it couldn't start\)/);
  // Not a Dash chat: the email cap is all there is.
  assert.deepEqual(planRoute({ ...ok, proven: false, size: huge }), { route: "blocked", reason: "too-big" });
  assert.equal(routeText(planRoute({ ...ok, oneToOne: false, size: huge })), "Too big to send by email (max 22 MB)");
  assert.equal(planRoute({ ...ok, available: false, size: big }).route, "email", "PWA: email under the cap");
  assert.equal(routeText(planRoute({ ...ok, size: 1000 })), "", "small files: nothing to say");
  assert.deepEqual(peerDomains(["Bob@Relay.Example", "x@other.example", "junk", null]), ["relay.example", "other.example"]);
});

// The composer's Send waits on the pre-send route. On a phone with no
// internet get_server_metadata never answered, the route never resolved and
// the send button did nothing at all (56 MB video, 2026-11-24).
test("Send never waits forever: a stalled route check, health call or offer times out", async () => {
  const ui = await import("../app/js/iroh-xfer-ui.js?stall");
  assert.deepEqual({ ...ui.WAIT_MS }, { metaMs: 4000, peerMs: 4000, healthMs: 12000, offerMs: 120000, offerPerMbMs: 100, fetchMs: 300000, fetchPerMbMs: 500 }, "production bounds");
  const diag = [];
  globalThis.window = Object.assign(new EventTarget(), { __veltaDiagnostics: { append: (lvl, text) => diag.push(text) } });
  const core = fakeCore({ "ui.velta.xfer.peer.12": "1700000000" });
  const hang = () => new Promise(() => {});
  let health = hang; // xfer_health
  let offer = hang;  // xfer_offer
  ui.initXferUi({
    core,
    invoke: async (cmd, args) => (cmd === "xfer_health" ? health(args) : cmd === "xfer_offer" ? offer(args) : null),
    sendText: async () => ({}), sendFile: async () => {},
    metadata: hang, // get_server_metadata: core lock held, or a dead network
    listen: async () => {},
    timeouts: { metaMs: 20, peerMs: 20, healthMs: 20, offerMs: 20, offerPerMbMs: 0 },
  });
  const huge = EMAIL_MAX + 1, ask = { size: huge, oneToOne: true, contactId: 12, peerName: "K" };
  // Both calls stall: the route still resolves. The shell answers health
  // within ~11 s even when its endpoint cannot start, so a stall means a
  // stuck Dash: the line says so (trying Dash anyway was the silent
  // two-minute Send on desktop, 2026-11-24).
  assert.deepEqual(await ui.planSend(ask), { route: "blocked", reason: "dash-down-too-big", why: "timeout", text: "Can't send: Velta Dash is unavailable (it is not responding) and the file is too big for email (max 22 MB)" });
  // A health call that fails outright (endpoint cannot start) is blocked over the cap too.
  health = async () => { throw new Error("no key"); };
  assert.deepEqual(await ui.planSend(ask), { route: "blocked", reason: "dash-down-too-big", why: "error", text: "Can't send: Velta Dash is unavailable (it couldn't start) and the file is too big for email (max 22 MB)" });
  // Failures are not cached: once Dash answers, the next attach goes Dash.
  health = async () => ({ ready: true, relay: null, relayConnected: false });
  assert.equal((await ui.planSend(ask)).route, "dash");
  // A stalled offer cannot hold Send either: over the cap it says Dash failed.
  assert.deepEqual(await ui.maybeSend({ chatId: 5, path: "/f", name: "v.mp4", size: huge, oneToOne: true, contactId: 12 }), {
    handled: true, failed: "too-big", msg: null,
    error: "Velta Dash didn't respond in time, and the file is too big for email (max 22 MB). Nothing was sent.",
  });
  assert.match(diag.at(-1), /offer failed and v\.mp4 .* not sent: .*rpc timeout: xfer_offer/);
  // The composer binds its own waits the same way and stays usable without a plan.
  const src = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  assert.match(src, /withTimeout\(invoke\("xfer_file_size", \{ path: pm\.corePath \}\), PLAN_TIMEOUT_MS/);
  assert.match(src, /withTimeout\(xferPlanSend\(\{/);
  assert.match(src, /pm\.plan = plan \|\| undefined/);
  assert.match(src, /!this\.chat\?\.isP2p && pm\.plan\?\.route !== "email"/, "no plan = try Dash first, Loop chats excepted");
  assert.match(src, /pm\?\.size != null \? formatBytes\(pm\.size\)/, "the strip shows the file size");
  assert.match(src, /checking \? t\("Checking how to send…"\)/);
  for (const pack of ["ru", "fr"]) assert.ok(JSON.parse(readFileSync(new URL(`../app/locales/${pack}.json`, import.meta.url), "utf8"))["Checking how to send…"], `${pack} has the string`);
});

test("a capability-check timeout still tries Dash", async () => {
  const ui = await import("../app/js/iroh-xfer-ui.js?peer-timeout");
  const diag = [];
  globalThis.window = Object.assign(new EventTarget(), { __veltaDiagnostics: { append: (_lvl, text) => diag.push(text) } });
  const core = fakeCore();
  core.getConfig = () => new Promise(() => {});
  const calls = [];
  ui.initXferUi({
    core,
    invoke: async (cmd, args) => {
      calls.push(cmd);
      if (cmd === "xfer_health") return { ready: true, relay: "https://r.example/", relayConnected: true };
      if (cmd === "xfer_offer") return offerOf({ hash: "ab".repeat(32), name: args.name });
      return null;
    },
    sendText: async (_chatId, text) => ({ id: 1, text }),
    sendFile: async () => { throw new Error("must not email"); },
    metadata: async () => ({ "me@relay.example": { irohRelay: "https://r.example/" } }),
    timeouts: { metaMs: 50, peerMs: 20, healthMs: 50, offerMs: 50, offerPerMbMs: 0 },
  });
  const huge = EMAIL_MAX + 1;
  const plan = await ui.planSend({ size: huge, oneToOne: true, contactId: 12, peerName: "K" });
  assert.equal(plan.route, "dash", "a timed-out read is not 'too big for email'");
  assert.equal(await ui.peerCanXfer(12), null);
  const out = await ui.maybeSend({ chatId: 5, path: "/f", name: "v.mp4", size: huge, oneToOne: true, contactId: 12 });
  assert.equal(out.handled, true);
  assert.equal(out.failed, undefined);
  assert.ok(calls.includes("xfer_offer"));
  assert.match(diag.join("\n"), /capability check timed out/);
  core.getConfig = async () => null;
  const blocked = await ui.planSend({ size: huge, oneToOne: true, contactId: 12, peerName: "K" });
  assert.equal(blocked.route, "blocked");
  assert.equal(blocked.reason, "too-big", "an empty answer still means they have not proved Dash");
});

test("transport: never mails what the relay would bounce; never asks for an email copy over the cap", async () => {
  const mailed = [];
  const email = { sendFile: async (c, f) => mailed.push(["file", f.name]), sendText: async (c, t) => mailed.push(["text", t]) };
  const failing = { offer: async () => { throw new Error("no relay"); }, fetch: async () => ({ error: "unreachable", code: "unreachable", email: true }) };
  const tr = createTransport({ email, iroh: failing, relay: async () => null, enabled: () => true });
  const r = await tr.send({ chatId: 5, file: { name: "film.mp4", size: EMAIL_MAX + 1, path: "/f" }, oneToOne: true, peerIsVelta: true });
  assert.equal(r.route, "none");
  assert.equal(r.tooBig, true);
  assert.deepEqual(mailed, [], "no 133 MB email, so no card the receiver can't download");
  const small = await tr.send({ chatId: 5, file: { name: "a.mp4", size: THRESHOLD + 1, path: "/a" }, oneToOne: true, peerIsVelta: true });
  assert.equal(small.route, "email", "under the cap the email fallback still works");
  mailed.length = 0;
  const hugeCard = fileCardText({ name: "film.mp4", size: EMAIL_MAX + 1, ticket: enc({ ...tk, size: EMAIL_MAX + 1 }) });
  const got = await tr.receive({ chatId: 5, text: hugeCard });
  assert.equal(got.tooBig, true);
  assert.deepEqual(mailed, [], "no RESEND the sender could not honour");
  const pwa = createTransport({ email, iroh: null });
  assert.equal((await pwa.receive({ chatId: 5, text: hugeCard })).tooBig, true);
  assert.deepEqual(mailed, []);
});

test("receiver card: waiting, progress, resumes, then Retry; fetch may use the sender's relay", async () => {
  globalThis.window = Object.assign(new EventTarget(), { __veltaDiagnostics: { append: () => {} } });
  globalThis.localStorage ??= { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  const ui = await import("../app/js/iroh-xfer-ui.js?states");
  ui.RETRY_DELAYS_MS.splice(0, ui.RETRY_DELAYS_MS.length, 0, 0);
  const core = fakeCore();
  core.accountId = 31;
  core.getChat = async (id) => ({ id, chatType: "Single", contactId: 12 });
  core.getContact = async () => ({ id: 12, addr: "kay@their-relay.example" });
  let release, fetchArgs = [], results = [];
  const gate = new Promise((r) => { release = r; });
  ui.initXferUi({
    core,
    invoke: async (cmd, args) => {
      if (cmd !== "xfer_fetch") return null;
      fetchArgs.push(args);
      if (fetchArgs.length === 1) await gate;
      return results.shift();
    },
    sendText: async () => ({ id: 1 }), sendFile: async () => {},
    metadata: async () => null,
    listen: async () => {},
  });
  const H = "ef".repeat(32);
  const card = fileCardText({ name: "v.mp4", size: tk.size, ticket: enc({ ...tk, hash: H }) });
  results.push({ error: "stalled", code: "io", email: false }, { error: "stalled", code: "io", email: false }, { error: "stalled", code: "io", email: false });
  core.msg(9, card);
  await tick();
  assert.match(ui.xferCardHtml(card), /Waiting for sender…/, "never a silent 'Downloading…'");
  assert.match(ui.xferCardHtml(card), /class="xfer-state is-busy"/, "waiting shows the busy ring");
  assert.doesNotMatch(ui.xferCardHtml(card), /xfer-preview-dead/, "in flight: no dead tile under the busy ring");
  assert.match(ui.xferCardHtml(card), /xfer-glyph/, "in flight: the file-type glyph stays");
  assert.deepEqual(fetchArgs[0].peers, ["their-relay.example"], "the receiver may dial the sender's own relay (4G: no direct path)");
  ui.xferProgressEvent({ hash: H, done: 34, size: 100 });
  assert.match(ui.xferCardHtml(card), /Fetching via Velta Dash 34%/);
  assert.match(ui.xferCardHtml(card), /class="xfer-state is-busy"/, "fetching shows the busy ring");
  release();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(fetchArgs.length, 3, "two quiet resumes");
  assert.match(ui.xferCardHtml(card), /Velta Dash transfer interrupted\./);
  assert.match(ui.xferCardHtml(card), /data-xfer-retry/, "a clear action, not an endless spinner");
  assert.doesNotMatch(ui.xferCardHtml(card), /is-busy/, "no ring once it stopped");
  assert.match(ui.xferCardHtml(card), /xfer-glyph/, "settled without bytes: the small kind tile (#519 feedback)");
  ui.xferProgressEvent({ hash: H, done: 50, size: 100 });
  assert.doesNotMatch(ui.xferCardHtml(card), /is-busy/, "a late progress event does not resurrect the ring");
  assert.match(ui.xferCardHtml(card), /Velta Dash transfer interrupted\./, "the settled error stands");
  results.push({ path: "/acc/xfer-in/v.mp4" });
  ui.retryFetch(H);
  await tick();
  assert.match(ui.xferCardHtml(card), /Received with Velta Dash/);

  // Over the email cap and Dash failed: say so, no ask button, Retry stays.
  const H3 = "a1".repeat(32);
  const huge = fileCardText({ name: "film.mp4", size: EMAIL_MAX + 1, ticket: enc({ ...tk, hash: H3, size: EMAIL_MAX + 1 }) });
  results.push({ error: "unreachable", code: "unreachable", email: true });
  core.msg(9, huge);
  await tick(); await tick();
  assert.match(ui.xferCardHtml(huge), /Fetch failed — the offer is still open, tap Retry\./);
  assert.doesNotMatch(ui.xferCardHtml(huge), /xfer-ask/);
  assert.match(ui.xferCardHtml(huge), /data-xfer-retry/);
  // Under the cap: Dash failed; the card offers the email copy and does not
  // ask by itself. The user's tap sends the request.
  const H4 = "b2".repeat(32);
  const mid = fileCardText({ name: "m.mp4", size: tk.size, ticket: enc({ ...tk, hash: H4 }) });
  results.push({ error: "unreachable", code: "unreachable", email: true });
  core.msg(9, mid);
  await tick(); await tick();
  assert.match(ui.xferCardHtml(mid), /Not available over Velta Dash/);
  assert.match(ui.xferCardHtml(mid), /data-xfer-ask/);
  await ui.askForEmailCopy(H4);
  assert.match(ui.xferCardHtml(mid), /Asked for the email copy/);
});

test("receiver card: a fetch that never settles still ends — hard cap, then a clear error + Retry", async () => {
  globalThis.window = Object.assign(new EventTarget(), { __veltaDiagnostics: { append: () => {} } });
  globalThis.localStorage ??= { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  const ui = await import("../app/js/iroh-xfer-ui.js?hangfetch");
  ui.RETRY_DELAYS_MS.splice(0, ui.RETRY_DELAYS_MS.length, 0, 0, 0);
  const core = fakeCore();
  core.accountId = 33;
  core.getChat = async (id) => ({ id, chatType: "Single", contactId: 12 });
  core.getContact = async () => ({ id: 12, addr: "kay@their-relay.example" });
  ui.initXferUi({
    core,
    // xfer_fetch never settles: the trickling-peer case every inner Rust
    // bound misses. The overall cap must end the card's spinner anyway.
    invoke: async (cmd) => (cmd === "xfer_fetch" ? new Promise(() => {}) : null),
    sendText: async () => ({}), sendFile: async () => {},
    metadata: async () => null,
    listen: async () => {},
    timeouts: { metaMs: 20, peerMs: 20, healthMs: 20, offerMs: 20, offerPerMbMs: 0, fetchMs: 25, fetchPerMbMs: 0 },
  });
  const H = "c3".repeat(32);
  const card = fileCardText({ name: "v.mp4", size: tk.size, ticket: enc({ ...tk, hash: H }) });
  ui.noteCard(9, card, false);
  assert.match(ui.xferCardHtml(card), /Waiting for sender…/, "in flight before the cap");
  await new Promise((r) => setTimeout(r, 400)); // 4 attempts x 25 ms cap + 0-delay retries
  await tick();
  assert.match(ui.xferCardHtml(card), /Velta Dash transfer interrupted\./, "the cap ends the endless spinner");
  assert.match(ui.xferCardHtml(card), /data-xfer-retry/);
  assert.doesNotMatch(ui.xferCardHtml(card), /is-busy/);
});

test("capability echo: after one message either way, BOTH phones show the Dash badge", async () => {
  globalThis.window = Object.assign(new EventTarget(), { __veltaDiagnostics: { append: () => {} } });
  globalThis.localStorage ??= { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  localStorage.removeItem("velta-iroh-xfer");
  // Two phones; each sees the other as contact 20 in chat 40. Core patch #31
  // (tested in core: test_velta_xfer_capability_echo) stamps every encrypted
  // message — an empty reaction too — while ui.velta.xfer=1, and the
  // receiver records ui.velta.xfer.peer.<id>. This net does the same.
  const phone = (acct) => {
    const core = fakeCore();
    core.accountId = acct;
    core.getChat = async (id) => ({ id, chatType: "Single", contactId: 20 });
    core.sent = [];
    return core;
  };
  const a = phone(41), b = phone(42);
  let msgId = 100;
  const deliver = (from, to, text, hidden = false) => {
    if (from.config["ui.velta.xfer"] === "1") to.config["ui.velta.xfer.peer.20"] = String(Date.now());
    if (!hidden) to.dispatchEvent(Object.assign(new Event("incoming-msg"), { detail: { chatId: 40, msg: { id: ++msgId, chatId: 40, text, from: 20, fromContact: { id: 20 } } } }));
  };
  for (const [me, peer] of [[a, b], [b, a]]) me.clearReaction = async () => { me.sent.push("echo"); deliver(me, peer, "", true); };
  const uiA = await import("../app/js/iroh-xfer-ui.js?phoneA");
  const uiB = await import("../app/js/iroh-xfer-ui.js?phoneB");
  const init = (ui, core) => ui.initXferUi({ core, invoke: async () => null, sendText: async () => ({}), sendFile: async () => {}, metadata: async () => null, listen: async () => {} });
  init(uiA, a); init(uiB, b);
  await tick();
  // Pavel's case: A wrote to B, so B already sees A's badge; A sees none.
  deliver(a, b, "hi");
  await tick();
  assert.equal(await uiB.peerCanXfer(20), true, "B sees A's badge");
  assert.equal(await uiA.peerCanXfer(20), true, "A sees B's badge too: B echoed on receipt");
  assert.deepEqual(b.sent, ["echo"]);
  assert.deepEqual(a.sent, [], "A has nothing to echo: B is already proven to A");
  deliver(a, b, "again");
  await tick();
  assert.deepEqual(b.sent, ["echo"], "one echo a week, not one per message");

  // The other direction on a fresh pair: B writes first, A echoes.
  const c = phone(43), d = phone(44);
  for (const [me, peer] of [[c, d], [d, c]]) me.clearReaction = async () => { me.sent.push("echo"); deliver(me, peer, "", true); };
  const uiC = await import("../app/js/iroh-xfer-ui.js?phoneC");
  const uiD = await import("../app/js/iroh-xfer-ui.js?phoneD");
  init(uiC, c); init(uiD, d);
  await tick();
  deliver(d, c, "hello");
  await tick();
  assert.equal(await uiC.peerCanXfer(20) && await uiD.peerCanXfer(20), true, "both badges after one message the other way");
});

// ---- #519: the Dash card reads as a file row ----
test("splitFileName keeps the extension; the two-part allow-list holds", async () => {
  const { splitFileName, fileKind } = await import("../app/js/iroh-xfer.js");
  assert.deepEqual(splitFileName("1795559326328-Replay_2026.02.09-03.05.mp4"),
    { base: "1795559326328-Replay_2026.02.09-03.05", ext: ".mp4" });
  assert.deepEqual(splitFileName("foo.tar.gz"), { base: "foo", ext: ".tar.gz" });
  assert.deepEqual(splitFileName("foo.tar.bz2"), { base: "foo", ext: ".tar.bz2" });
  assert.deepEqual(splitFileName("bare.gz"), { base: "bare", ext: ".gz" });
  assert.deepEqual(splitFileName(".mp4"), { base: ".mp4", ext: "" }, "a leading-dot name is all base");
  assert.deepEqual(splitFileName("noext"), { base: "noext", ext: "" });
  assert.equal(fileKind("Replay_2026.02.09-03.05.mp4"), "video");
  assert.equal(fileKind("x.tar.bz2"), "archive");
  assert.equal(fileKind("song.flac"), "audio");
  assert.equal(fileKind("noext"), "file");
});


test("the card renders a file row: icon tile, one-line name, size row, foot", async () => {
  const { P } = await import("../app/js/icons.js");
  const ui = await import("../app/js/iroh-xfer-ui.js");
  const name = "1795559063928-session-recording.flac"; // non-media: the tile is the type icon, not a preview
  const html = ui.xferCardHtml(fileCardText({ name, size: 7.2 * 1048576, ticket: enc({ ...tk, hash: "55".repeat(32), name }) }));
  const mic = P.mic.slice(0, 24).replaceAll("(", "\(").replaceAll(")", "\)");
  assert.match(html, new RegExp(mic), "the tile is the type icon (P.mic for .flac), not a letter");
  assert.doesNotMatch(html, /xfer-glyph">[^<]<\/span>/, "no single-letter tile");
  const nm = /<span class="xfer-name-base">(.*?)<\/span><span class="xfer-name-ext">(.*?)<\/span>/.exec(html);
  assert.ok(nm, "the name splits into base + ext");
  assert.equal(nm[1] + nm[2], name, "base + ext are the full name, no gap between the spans");
  assert.equal(nm[2], ".flac", "the extension stays");
  assert.match(html, /class="xfer-sub"/, "size + chip + actions share one row");
  assert.match(html, /class="xfer-foot"/, "the status shares the timestamp row");
  assert.match(html, /xfer-meta-slot/, "chat-view fills the timestamp slot");
  assert.doesNotMatch(html, /is-error/, "steady states do not carry the error wrap");
});

test("receiver card: a persisted done state whose stored copy is gone/unreadable is dropped and re-fetched", async () => {
  // localStorage survives a profile recreate (the account rowid in the store
  // key collides with the fresh profile's) and a same-content resend hashes
  // to the same card — while the old file is gone or sealed under a key this
  // install no longer has. The stale done+path must not suppress the fetch
  // or show a phantom "Received" with a dead preview.
  globalThis.window = Object.assign(new EventTarget(), { __veltaDiagnostics: { append: () => {} } });
  globalThis.localStorage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  const ui = await import("../app/js/iroh-xfer-ui.js?stalerecv");
  const core = fakeCore();
  core.accountId = 55;
  core.getChat = async (id) => ({ id, chatType: "Single", contactId: 12 });
  core.getContact = async () => ({ id: 12, addr: "kay@their-relay.example" });
  const H = "e5".repeat(32);
  const calls = [];
  // Yesterday's persisted state: done, pointing at a copy that no longer opens.
  localStorage.setItem("velta-xfer-cards:55", JSON.stringify({ [H]: { chatId: 9, path: "/old/xfer-in/stale.bin", done: true, size: tk.size, name: "stale.bin" } }));
  ui.initXferUi({
    core,
    invoke: async (cmd, args) => {
      calls.push(cmd);
      if (cmd === "xfer_file_size") throw new Error("attachment key authentication failed"); // stale copy under a lost key
      if (cmd === "xfer_fetch") return { path: "/acc/xfer-in/fresh.bin" };
      if (cmd === "xfer_status") return {};
      return null;
    },
    sendText: async () => ({}), sendFile: async () => {},
    metadata: async () => null,
    listen: async () => {},
  });
  // Yesterday's persisted state was seeded before init (loadCards reads it).
  const card = fileCardText({ name: "stale.bin", size: tk.size, ticket: offerOf({ hash: H, name: "stale.bin" }) });
  ui.noteCard(9, card, false); // first sight of the same-hash card in the fresh profile
  await tick(); await tick();
  assert.ok(calls.includes("xfer_file_size"), "the persisted copy is validated against the live key");
  assert.ok(calls.includes("xfer_fetch"), "the stale done state does not suppress the re-fetch");
  assert.match(ui.xferCardHtml(card), /Received with Velta Dash/, "the card settles on the fresh copy");
  const stored = JSON.parse(localStorage.getItem("velta-xfer-cards:55") || "{}");
  assert.equal(stored[H]?.path, "/acc/xfer-in/fresh.bin", "the persisted path is the fresh fetch, not the stale one");
});

test("outgoing card: a stale staged path is dropped without a fetch", async () => {
  globalThis.window = Object.assign(new EventTarget(), { __veltaDiagnostics: { append: () => {} } });
  globalThis.localStorage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  const ui = await import("../app/js/iroh-xfer-ui.js?staleout");
  const core = fakeCore();
  core.accountId = 56;
  const calls = [];
  const H = "f6".repeat(32);
  localStorage.setItem("velta-xfer-cards:56", JSON.stringify({ [H]: { chatId: 9, path: "/old/uploads/staged.bin", done: true, outgoing: true, size: tk.size, name: "staged.bin" } }));
  ui.initXferUi({
    core,
    invoke: async (cmd) => { calls.push(cmd); if (cmd === "xfer_file_size") throw new Error("attachment key authentication failed"); return null; },
    sendText: async () => ({}), sendFile: async () => {},
    metadata: async () => null,
    listen: async () => {},
  });
  const card = fileCardText({ name: "staged.bin", size: tk.size, ticket: offerOf({ hash: H, name: "staged.bin" }) });
  ui.noteCard(9, card, true);
  await tick(); await tick();
  assert.ok(calls.includes("xfer_file_size"));
  assert.ok(!calls.includes("xfer_fetch"), "the sender's own card never fetches");
  const stored = JSON.parse(localStorage.getItem("velta-xfer-cards:56") || "{}");
  assert.equal(stored[H]?.path, undefined, "the dead preview path is dropped");
  assert.match(ui.xferCardHtml(card), /Sent with Velta Dash/, "the card still reads as sent");
});

test("receiver card: a same-content resend flips a dead outgoing state to a fresh fetch", async () => {
  // Yesterday WE sent the file (outgoing state, staged path). The profile was
  // then recreated: the staged copy is sealed under a lost key and the engine
  // lost the offer itself (offers.json under the old key → sweep says
  // "missing"). Today the PEER sends the same content — same hash. The dead
  // outgoing state must not block the incoming card: fetch the peer's ticket.
  globalThis.window = Object.assign(new EventTarget(), { __veltaDiagnostics: { append: () => {} } });
  globalThis.localStorage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  const ui = await import("../app/js/iroh-xfer-ui.js?flip");
  const core = fakeCore();
  core.accountId = 57;
  core.getChat = async (id) => ({ id, chatType: "Single", contactId: 12 });
  core.getContact = async () => ({ id: 12, addr: "kay@their-relay.example" });
  const calls = [];
  const H1 = "a1".repeat(32), H2 = "b2".repeat(32);
  localStorage.setItem("velta-xfer-cards:57", JSON.stringify({
    [H1]: { chatId: 9, path: "/old/uploads/staged.bin", done: true, outgoing: true, size: tk.size, name: "flip.bin" },
    [H2]: { chatId: 9, outgoing: true, error: "missing", size: tk.size, name: "flip2.bin" },
  }));
  ui.initXferUi({
    core,
    invoke: async (cmd) => {
      calls.push(cmd);
      if (cmd === "xfer_file_size") throw new Error("attachment key authentication failed");
      if (cmd === "xfer_fetch") return { path: "/acc/xfer-in/resent.bin" };
      if (cmd === "xfer_status") return {};
      return null;
    },
    sendText: async () => ({}), sendFile: async () => {},
    metadata: async () => null,
    listen: async () => {},
  });
  const card1 = fileCardText({ name: "flip.bin", size: tk.size, ticket: offerOf({ hash: H1, name: "flip.bin" }) });
  const card2 = fileCardText({ name: "flip2.bin", size: tk.size, ticket: offerOf({ hash: H2, name: "flip2.bin" }) });
  ui.noteCard(9, card1, false); // incoming resend, dead staged copy on disk
  ui.noteCard(9, card2, false); // incoming resend, offer already swept as missing
  await tick(); await tick();
  assert.equal(calls.filter((c) => c === "xfer_fetch").length, 2, "both flipped cards fetch the peer's fresh copy");
  assert.match(ui.xferCardHtml(card1), /Received with Velta Dash/);
  assert.match(ui.xferCardHtml(card2), /Received with Velta Dash/);
  const stored = JSON.parse(localStorage.getItem("velta-xfer-cards:57") || "{}");
  assert.equal(stored[H1]?.outgoing, undefined, "the outgoing mark is gone");
  assert.equal(stored[H1]?.path, "/acc/xfer-in/resent.bin", "the persisted path is the fresh fetch");
  assert.equal(stored[H2]?.error, undefined, "the swept missing error is gone");
});

test("a live stored copy is size-checked once per session, not once per render", async () => {
  // noteCard runs on every bubble render. #558 re-validated outgoing cards
  // on every render (the once-per-session exit excluded `st.outgoing`),
  // firing an xfer_file_size IPC per render per card.
  globalThis.window = Object.assign(new EventTarget(), { __veltaDiagnostics: { append: () => {} } });
  globalThis.localStorage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  const ui = await import("../app/js/iroh-xfer-ui.js?reval1");
  const core = fakeCore();
  core.accountId = 58;
  const H = "e7".repeat(32);
  localStorage.setItem("velta-xfer-cards:58", JSON.stringify({ [H]: { chatId: 9, path: "/acc/uploads/live.bin", done: true, outgoing: true, size: tk.size, name: "live.bin" } }));
  let sizeCalls = 0;
  ui.initXferUi({
    core,
    invoke: async (cmd) => { if (cmd === "xfer_file_size") sizeCalls++; return 1234; }, // copy opens fine
    sendText: async () => ({}), sendFile: async () => {},
    metadata: async () => null,
    listen: async () => {},
  });
  const card = fileCardText({ name: "live.bin", size: tk.size, ticket: offerOf({ hash: H, name: "live.bin" }) });
  ui.noteCard(9, card, true);
  await tick(); await tick();
  ui.noteCard(9, card, true); // second render of the same bubble
  ui.noteCard(9, card, true); // third render
  await tick(); await tick();
  assert.equal(sizeCalls, 1, "one size check per session for a validated copy");
  assert.ok(!JSON.parse(localStorage.getItem("velta-xfer-cards:58"))[H].error, "the live copy is left untouched");
});

test("renders of one card during an in-flight size check do not race a second check", async () => {
  // #558 dropped the in-flight guard together with the early exit: until the
  // size read settled, every render re-entered the check for the same copy.
  globalThis.window = Object.assign(new EventTarget(), { __veltaDiagnostics: { append: () => {} } });
  globalThis.localStorage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  const ui = await import("../app/js/iroh-xfer-ui.js?reval2");
  const core = fakeCore();
  core.accountId = 61;
  const H = "83".repeat(32);
  localStorage.setItem("velta-xfer-cards:61", JSON.stringify({ [H]: { chatId: 9, path: "/acc/xfer-in/live.bin", done: true, size: tk.size, name: "live.bin" } }));
  let sizeCalls = 0; let settle;
  ui.initXferUi({
    core,
    invoke: async (cmd) => {
      if (cmd === "xfer_file_size") { sizeCalls++; return new Promise((res) => { settle = res; }); }
      return null;
    },
    sendText: async () => ({}), sendFile: async () => {},
    metadata: async () => null,
    listen: async () => {},
  });
  const card = fileCardText({ name: "live.bin", size: tk.size, ticket: offerOf({ hash: H, name: "live.bin" }) });
  ui.noteCard(9, card, false); // first render: check starts, hangs
  ui.noteCard(9, card, false); // second render while the check is in flight
  await tick();
  assert.equal(sizeCalls, 1, "the in-flight check dedupes parallel renders");
  settle(4096);
  await tick(); await tick();
  ui.noteCard(9, card, false); // render after validation: still no new check
  await tick(); await tick();
  assert.equal(sizeCalls, 1, "a validated copy is not re-checked on later renders");
});

test("a failed size check of a stale path must not wipe a path a retry already replaced", async () => {
  // The catch ran without comparing the card's current path to the probed
  // one: while a stale-path check was in flight, a Retry could fetch a
  // fresh copy — the stale failure then wiped the fresh path and started
  // the download over.
  globalThis.window = Object.assign(new EventTarget(), { __veltaDiagnostics: { append: () => {} } });
  globalThis.localStorage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  const ui = await import("../app/js/iroh-xfer-ui.js?race");
  const core = fakeCore();
  core.accountId = 60;
  core.getChat = async (id) => ({ id, chatType: "Single", contactId: 12 });
  core.getContact = async () => ({ id: 12, addr: "kay@their-relay.example" });
  const H = "9a".repeat(32);
  localStorage.setItem("velta-xfer-cards:60", JSON.stringify({ [H]: { chatId: 9, path: "/old/xfer-in/stale.bin", error: "interrupted", size: tk.size, name: "race.bin" } }));
  let fetchCalls = 0; let failStaleCheck;
  ui.initXferUi({
    core,
    invoke: async (cmd, args) => {
      if (cmd === "xfer_file_size") return new Promise((_, rej) => { failStaleCheck = () => rej(new Error("attachment key authentication failed")); }); // the stale check hangs
      if (cmd === "xfer_fetch") { fetchCalls++; return { path: "/acc/xfer-in/fresh.bin" }; }
      return null;
    },
    sendText: async () => ({}), sendFile: async () => {},
    metadata: async () => null,
    listen: async () => {},
  });
  const card = fileCardText({ name: "race.bin", size: tk.size, ticket: offerOf({ hash: H, name: "race.bin" }) });
  ui.noteCard(9, card, false); // incoming render: stale-path check starts, hangs
  await tick();
  ui.retryFetch(H); // the user retries while the stale check is still in flight → fresh copy lands
  await tick(); await tick();
  failStaleCheck(); // the stale-path check finally fails
  await tick(); await tick();
  assert.equal(fetchCalls, 1, "the fresh fetch is not repeated");
  assert.equal(JSON.parse(localStorage.getItem("velta-xfer-cards:60"))[H]?.path, "/acc/xfer-in/fresh.bin", "the fresh path survives the stale failure");
  assert.match(ui.xferCardHtml(card), /Received with Velta Dash/, "the card keeps the fresh copy");
});

test("#546: a failed fetch on an un-mailable file blames the offer only when it expired", async t => {
  globalThis.window = Object.assign(new EventTarget(), { __veltaDiagnostics: { append: () => {} } });
  globalThis.localStorage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  const ui = await import("../app/js/iroh-xfer-ui.js?big");
  const core = fakeCore({ "ui.velta.xfer.peer.12": "1700000000" });
  const H2 = (c) => c.repeat(32);
  ui.initXferUi({
    core,
    // Every fetch fails with an email-able-code: the route is dead, but the
    // email fallback is impossible over EMAIL_MAX — the copy must say which.
    invoke: async (cmd, args) => (cmd === "xfer_fetch" ? { error: "boom", code: "stalled", email: true } : null),
    sendText: async () => ({ id: 1 }),
    sendFile: async () => {},
    metadata: async () => null,
  });
  await tick();
  const nowS = Math.floor(Date.now() / 1000);
  const live = fileCardText({ name: "big.bin", size: EMAIL_MAX + 1, ticket: offerOf({ hash: H2("11"), name: "big.bin", exp: nowS + 3600, size: EMAIL_MAX + 1 }) });
  core.msg(9, live);
  await tick();
  assert.match(ui.xferCardHtml(live), /offer is still open, tap Retry/, "a live offer: Retry is the answer, not a resend");

  const dead = fileCardText({ name: "old.bin", size: EMAIL_MAX + 1, ticket: offerOf({ hash: H2("22"), name: "old.bin", exp: nowS - 60, size: EMAIL_MAX + 1 }) });
  core.msg(9, dead);
  await tick();
  assert.match(ui.xferCardHtml(dead), /offer has expired.*ask the sender to resend/s, "expired: the resend ask is honest");
});

test("Dash card actions: desktop folder, Android Save+Share, PWA download", async () => {
  const ui = await import("../app/js/iroh-xfer-ui.js");
  const hash = "ab".repeat(32);
  const st = { path: "/acc/xfer-in/clip.mp4" };
  const desk = ui.xferActionsHtml(hash, "clip.mp4", st, "folder");
  assert.match(desk, /data-xfer-folder/);
  assert.match(desk, /Show in folder/);
  assert.match(desk, /class="xfer-folder btn-text"/);
  assert.doesNotMatch(desk, /data-xfer-save/);
  assert.doesNotMatch(desk, /data-xfer-share/);
  const droid = ui.xferActionsHtml(hash, "clip.mp4", st, "save-share");
  assert.match(droid, /data-xfer-save/);
  assert.match(droid, /data-xfer-share/);
  assert.match(droid, /class="xfer-save btn-text"/);
  assert.match(droid, /class="xfer-share btn-text"/);
  assert.doesNotMatch(droid, /data-xfer-folder/);
  assert.doesNotMatch(droid, /Show in folder/);
  const pwa = ui.xferActionsHtml(hash, "clip.mp4", st, "save");
  assert.match(pwa, /data-xfer-save/);
  assert.doesNotMatch(pwa, /data-xfer-share/);
  assert.doesNotMatch(pwa, /data-xfer-folder/);
  const doc = ui.xferActionsHtml(hash, "got.bin", st, "folder");
  assert.match(doc, /data-xfer-open/);
  assert.doesNotMatch(doc, /data-xfer-folder/);
  const docA = ui.xferActionsHtml(hash, "got.bin", st, "save-share");
  assert.match(docA, /data-xfer-open/);
  assert.match(docA, /data-xfer-save/);
  assert.match(docA, /data-xfer-share/);
  assert.equal(ui.xferSaveKind("clip.mp4"), "video");
  assert.equal(ui.xferSaveKind("shot.png"), "image");
  assert.equal(ui.xferSaveKind("notes.pdf"), "file");
  assert.equal(ui.xferSaveKind("song.mp3"), "file", "audio goes to Download/Velta");
  assert.equal(ui.xferSaveFolder("video"), "Movies/Velta");
  assert.equal(ui.xferSaveFolder("image"), "Pictures/Velta");
  assert.equal(ui.xferSaveFolder("file"), "Download/Velta");
  assert.equal(ui.xferPlatformActions({ tauri: true, android: false }), "folder");
  assert.equal(ui.xferPlatformActions({ tauri: true, android: true }), "save-share");
  assert.equal(ui.xferPlatformActions({ tauri: false, android: false }), "save");
});

test("Delta Chat explainer is hidden from Velta; old wording still parses", () => {
  const ticket = enc(tk);
  const text = fileCardText({ name: tk.name, size: tk.size, ticket });
  assert.equal(xferDisplayText(text), "📎 Фильм.mp4 · 6.7 MB");
  assert.equal(xferVisibleText(text), "📎 Фильм.mp4 · 6.7 MB");
  assert.ok(!xferVisibleText(text).includes("velta.cc/dash"));
  assert.ok(!xferVisibleText(text).includes(ticket));
  assert.ok(!xferVisibleText(text).includes("was sent with Velta Dash"));

  const oldDash = `📎 shot.jpg · 576.7 KB — sent with Velta Dash\nIf your app can't open this, the file follows by email.\n${ticket}`;
  assert.equal(parseFileCard(oldDash).ticket, ticket);
  assert.equal(xferDisplayText(oldDash), "📎 Фильм.mp4 · 6.7 MB", "size and name come from the ticket");

  const beam = `Offering Screenshot_1.jpg (576.7 KB) — open "Velta Beam" to receive\n${ticket}`;
  assert.equal(parseFileCard(beam).name, tk.name);
  assert.equal(xferDisplayText(beam), "📎 Фильм.mp4 · 6.7 MB");

  // Truncated chat-list / notification summaries have no ticket.
  assert.equal(xferDisplayText("📦 film.mp4 (52.9 MB) was sent with Velta Dash, which sends files"), "📎 film.mp4 · 52.9 MB");
  assert.equal(xferDisplayText("📎 a.bin · 6.7 MB — sent with Velta Dash"), "📎 a.bin · 6.7 MB");
  assert.equal(xferDisplayText("Offering Screenshot_1.jpg (576.7 KB) — open \"Velta Beam\" to receive"), "📎 Screenshot_1.jpg · 576.7 KB");
  assert.equal(xferDisplayText("📦 x (1.0 MB) a été envoyé avec Velta Dash, qui envoie des fichiers"), "📎 x · 1.0 MB");
  assert.equal(xferDisplayText("Alice: 📦 film.mp4 (52.9 MB) was sent with Velta Dash, which sends files"), "📎 film.mp4 · 52.9 MB");
  assert.equal(xferDisplayText("📦 y (2.0 MB) отправлено через Velta Dash — передача файлов"), "📎 y · 2.0 MB");
  assert.equal(xferDisplayText("Open it in Velta, or learn more at https://velta.cc/dash"), "Velta Dash");
  assert.equal(xferDisplayText(resendRequestText(tk.hash)), "Asked for the email copy");
  assert.equal(xferDisplayText("hello about Velta Dash later"), null, "ordinary mention of the name is not rewritten");
  assert.equal(xferVisibleText("hello"), "hello");
  assert.equal(looksLikeXferExplainer("just a chat"), false);
  assert.equal(looksLikeXferExplainer(text), true);
});

test("Velta hides the explainer in the chat list, quotes, notifications, search and copy", () => {
  const src = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
  const ui = src("app/js/chat-view.js");
  const app = src("app/js/app.js");
  const rpc = src("app/js/rpc-core.js");
  assert.match(ui, /xferVisibleText\(m\.text\)/);
  assert.match(ui, /xferVisibleText\(m\.quote\.text/);
  assert.match(ui, /xferVisibleText\(this\.replyTo\.text/);
  assert.match(app, /xferVisibleText\(msg\?\.text/);
  assert.match(app, /xferVisibleText\(m\.text \|\| ""\)\.slice\(0, 80\)/);
  assert.match(rpc, /xferDisplayText\(c\.summaryText2\)/);
  assert.match(rpc, /xferVisibleText\(q\.text/);
  // The bubble still becomes a file card, never the explainer.
  const md = src("app/js/markdown.js");
  assert.match(md, /xferCardHtml\(rawText\)/);
});


// ---- explicit download: arrival never starts a transfer or posts a request on its own ----
function holdRig(tag, { chat = { chatType: "Single", contactId: 12, isContactRequest: false }, invoke = true } = {}) {
  globalThis.window = Object.assign(new EventTarget(), { __veltaDiagnostics: { append: () => {} } });
  globalThis.localStorage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  const calls = [], texts = [];
  const core = fakeCore();
  core.accountId = 70;
  core.getChat = async (id) => ({ id, ...chat });
  core.getContact = async () => ({ id: 12, addr: "kay@their-relay.example" });
  const env = {
    core, calls, texts,
    init: async () => {
      const ui = await import(`../app/js/iroh-xfer-ui.js?hold-${tag}`);
      ui.initXferUi({
        core,
        invoke: invoke ? async (cmd, args) => {
          calls.push(cmd);
          if (cmd === "xfer_fetch") return { path: "/acc/xfer-in/x.bin" };
          return null;
        } : null,
        sendText: async (chatId, text) => { texts.push({ chatId, text }); return { id: texts.length }; },
        sendFile: async () => {}, metadata: async () => null, listen: async () => {},
      });
      return ui;
    },
  };
  return env;
}
const heldCard = (c, extra = {}) => fileCardText({ name: "x.bin", size: tk.size, ticket: enc({ ...tk, hash: c.repeat(32), ...extra }) });

test("explicit download: a contact-request chat never fetches or posts a request", async () => {
  const rig = holdRig("req", { chat: { chatType: "Single", contactId: 12, isContactRequest: true } });
  const ui = await rig.init();
  const card = heldCard("e1");
  rig.core.msg(5, card);
  await tick();
  assert.equal(rig.calls.filter((c) => c === "xfer_fetch").length, 0);
  assert.deepEqual(rig.texts, []);
  assert.match(ui.xferCardHtml(card), /data-xfer-download/);
  ui.downloadCard("e1".repeat(32)); // the user's tap
  await tick();
  assert.equal(rig.calls.filter((c) => c === "xfer_fetch").length, 1);
  assert.match(ui.xferCardHtml(card), /Received with Velta Dash/);
});

test("explicit download: Dash off — no automatic fetch", async () => {
  const rig = holdRig("off");
  const ui = await rig.init();
  localStorage.setItem("velta-iroh-xfer", "0");
  const card = heldCard("e2");
  rig.core.msg(5, card);
  await tick();
  assert.equal(rig.calls.filter((c) => c === "xfer_fetch").length, 0);
  assert.deepEqual(rig.texts, []);
  assert.match(ui.xferCardHtml(card), /data-xfer-download/);
});

test("explicit download: Text-only mode (all messages) — no automatic fetch", async () => {
  const rig = holdRig("txt");
  const ui = await rig.init();
  localStorage.setItem("velta-text-only", "all");
  const card = heldCard("e3");
  rig.core.msg(5, card);
  await tick();
  assert.equal(rig.calls.filter((c) => c === "xfer_fetch").length, 0);
  assert.match(ui.xferCardHtml(card), /data-xfer-download/);
});

test("explicit download: an unreadable chat fails closed", async () => {
  const rig = holdRig("err");
  const ui = await rig.init();
  rig.core.getChat = async () => { throw new Error("boom"); };
  const card = heldCard("e4");
  rig.core.msg(5, card);
  await tick();
  assert.equal(rig.calls.filter((c) => c === "xfer_fetch").length, 0);
  assert.match(ui.xferCardHtml(card), /data-xfer-download/);
});

test("explicit download: accepted chat with Dash on fetches on arrival, as before", async () => {
  const rig = holdRig("ok");
  const ui = await rig.init();
  const card = heldCard("e5");
  rig.core.msg(5, card);
  await tick();
  assert.equal(rig.calls.filter((c) => c === "xfer_fetch").length, 1);
  assert.match(ui.xferCardHtml(card), /Received with Velta Dash/);
  assert.doesNotMatch(ui.xferCardHtml(card), /data-xfer-download/);
});

test("explicit download: an expired or unknown offer is not answered until the user acts", async () => {
  const rig = holdRig("gone");
  const ui = await import("../app/js/iroh-xfer-ui.js?hold-gone");
  ui.initXferUi({
    core: rig.core,
    invoke: async (cmd) => (cmd === "xfer_fetch" ? { error: "offer expired", code: "expired", email: true } : null),
    sendText: async (chatId, text) => { rig.texts.push({ chatId, text }); return { id: 1 }; },
    sendFile: async () => {}, metadata: async () => null, listen: async () => {},
  });
  const card = heldCard("e7");
  rig.core.msg(5, card);
  await tick(); await tick();
  assert.deepEqual(rig.texts, [], "no VXFER-RESEND on arrival");
  assert.match(ui.xferCardHtml(card), /data-xfer-ask/);
  await ui.askForEmailCopy("e7".repeat(32));
  assert.deepEqual(rig.texts, [{ chatId: 5, text: resendRequestText("e7".repeat(32)) }], "only the user's action sends it");
});

test("explicit download: PWA (no iroh) in a contact request sends nothing until Download", async () => {
  const rig = holdRig("pwareq", { chat: { chatType: "Single", contactId: 12, isContactRequest: true }, invoke: false });
  const ui = await rig.init();
  const card = heldCard("e8");
  rig.core.msg(5, card);
  await tick();
  assert.deepEqual(rig.texts, []);
  ui.downloadCard("e8".repeat(32));
  await tick();
  assert.deepEqual(rig.texts, [{ chatId: 5, text: resendRequestText("e8".repeat(32)) }]);
});
