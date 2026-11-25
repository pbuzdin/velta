// #470: policy and message formats of the automatic iroh file transfer.
// The transfer itself is tested in velta-app/src-tauri/src/xfer.rs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  THRESHOLD, chooseRoute, irohXferEnabled, setIrohXferEnabled, advertisedRelay, decodeTicket,
  fileCardText, parseFileCard, resendRequestText, parseResendRequest, createTransport, EMAIL_MAX, DELIVERED_GRACE_MS,
  dashState, dashExplainer, emailReason, routeLabel, SETTING_LABEL,
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
  assert.match(text.split("\n")[0], /Фильм\.mp4 · 6\.7 MB/);
  assert.match(text.split("\n")[1], /follows by email/, "Delta Chat readers learn the file comes by email");
  const card = parseFileCard(text);
  assert.equal(card.ticket, ticket);
  assert.equal(card.size, tk.size);
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
  ui.noteCard(6, texts[0].text, true);
  assert.match(ui.xferCardHtml(texts[0].text), /Sent with Velta Dash/);
  assert.match(ui.xferCardHtml(texts[0].text), /class="xfer-route" data-route="dash"/, "card badge: the path taken");
  assert.doesNotMatch(ui.xferCardHtml(texts[0].text), /xfer-ask/, "the sending device has the file: no ask button");

  // A card arriving while its chat is closed is fetched from the core event.
  const got = fileCardText({ name: "got.bin", size: tk.size, ticket: offerOf({ hash: H2("aa"), name: "got.bin" }) });
  core.msg(9, got);
  await tick();
  assert.match(ui.xferCardHtml(got), /Received/);
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
  assert.match(ui.xferCardHtml(clip), /Play video/, "video action says what it does");
  assert.match(ui.xferCardHtml(shot), /Open image/, "image action says what it does");
  assert.match(ui.xferCardHtml(clip), /Show in folder/, "desktop: reveal the file");
  assert.match(ui.xferCardHtml(got), /xfer-open/, "documents keep the Open link");
  // A media ticket with no local bytes (the sender's other device, or before
  // the fetch) shows the placeholder tile instead of staying silent — never
  // an empty preview src. Documents keep the file-type glyph.
  const ghost = fileCardText({ name: "ghost.mp4", size: tk.size, ticket: offerOf({ hash: H2("ff"), name: "ghost.mp4" }) });
  ui.noteCard(6, ghost, true);
  const ghostHtml = ui.xferCardHtml(ghost);
  assert.match(ghostHtml, /xfer-preview-dead/, "no bytes: the tile says why");
  assert.match(ghostHtml, /Preview unavailable/);
  assert.doesNotMatch(ghostHtml, /src=""/, "never an empty src");
  assert.doesNotMatch(ghostHtml, /xfer-glyph/, "media never falls back to the letter tile");

  // No free space: a clear error, and no email request (the disk is the problem).
  const full = fileCardText({ name: "full.bin", size: tk.size, ticket: offerOf({ hash: H2("bb"), name: "full.bin" }) });
  core.msg(9, full);
  await tick();
  assert.match(ui.xferCardHtml(full), /Not enough free space/);
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
  assert.deepEqual(texts, [{ chatId: 8, text: resendRequestText("12".repeat(32)) }], "auto-requested");
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
  assert.match(fileCardText({ name: "a.bin", size: tk.size, ticket: "VXFER1:x" }).split("\n")[0], /sent with Velta Dash/);
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

test("Velta Dash icon: house-style outline glyph, not Beam or Loop", async () => {
  const { P, ICON } = await import("../app/js/icons.js");
  assert.ok(P.dash && P.dash !== P.loop);
  assert.doesNotMatch(P.dash, /fill="currentColor"/);
  assert.match(ICON.dash, /stroke-width="2"/);
  assert.match(ICON.dash, /aria-hidden="true"/);
});

test("Velta Dash header badge: hidden by default, labelled, 44px hit area; drawer toggle is branded", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  const btn = /<button[^>]*id="btn-dash"[^>]*>/.exec(html)?.[0] || "";
  assert.match(btn, /\bhidden\b/);
  assert.match(btn, /aria-label="Velta Dash is on with this contact"/);
  assert.match(btn, /data-i18n-label="Velta Dash is on with this contact"/);
  assert.match(html, /id="btn-dash"[\s\S]*?data-icon="dash"/);
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  const rule = /\.dash-badge \{[^}]*\}/.exec(css)?.[0] || "";
  assert.match(rule, /min-width: 44px/);
  assert.match(rule, /min-height: 44px/);
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /data-setting="dash">\$\{ICON\.dash\}/);
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
  assert.deepEqual({ ...ui.WAIT_MS }, { metaMs: 4000, peerMs: 4000, healthMs: 12000, offerMs: 120000, offerPerMbMs: 100 }, "production bounds");
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
  results.push({ path: "/acc/xfer-in/v.mp4" });
  ui.retryFetch(H);
  await tick();
  assert.match(ui.xferCardHtml(card), /Received/);

  // Over the email cap and Dash failed: say so, no ask button, Retry stays.
  const H3 = "a1".repeat(32);
  const huge = fileCardText({ name: "film.mp4", size: EMAIL_MAX + 1, ticket: enc({ ...tk, hash: H3, size: EMAIL_MAX + 1 }) });
  results.push({ error: "unreachable", code: "unreachable", email: true });
  core.msg(9, huge);
  await tick(); await tick();
  assert.match(ui.xferCardHtml(huge), /Too large for email: ask the sender to resend while you are both online\./);
  assert.doesNotMatch(ui.xferCardHtml(huge), /xfer-ask/);
  assert.match(ui.xferCardHtml(huge), /data-xfer-retry/);
  // Under the cap: the card says Dash failed and the email copy was asked for.
  const H4 = "b2".repeat(32);
  const mid = fileCardText({ name: "m.mp4", size: tk.size, ticket: enc({ ...tk, hash: H4 }) });
  results.push({ error: "unreachable", code: "unreachable", email: true });
  core.msg(9, mid);
  await tick(); await tick();
  assert.match(ui.xferCardHtml(mid), /Couldn&#39;t fetch via Velta Dash: asked for the email copy|Couldn't fetch via Velta Dash: asked for the email copy/);
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
