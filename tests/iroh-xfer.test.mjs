// #470: policy and message formats of the automatic iroh file transfer.
// The transfer itself is tested in velta-app/src-tauri/src/xfer.rs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  THRESHOLD, chooseRoute, irohXferEnabled, setIrohXferEnabled, advertisedRelay, decodeTicket,
  fileCardText, parseFileCard, resendRequestText, parseResendRequest,
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
  assert.equal(await a.onResendRequest({ text: sentB[0] }), "v.mkv", "mails the pending file");
  assert.deepEqual(sentA.slice(1), [["withdraw", tk.hash], ["file", "v.mkv"]]);
  assert.equal(await a.onResendRequest({ text: sentB[0] }), null, "only once");
  const c = createTransport({ enabled: () => true, email: { sendFile: async () => {}, sendText: async () => {} }, iroh: { fetch: async () => ({ error: "Io(reset)", email: false }) } });
  assert.equal((await c.receive({ chatId: 1, text: sentA[0][1] })).retry, true, "broken stream: resume over iroh, no email");
});

test("ui glue: send routes, cards render, fetch states and the resend fallback", async () => {
  const ui = await import("../app/js/iroh-xfer-ui.js");
  const texts = [], files = [], offers = [];
  let fetchResult = { path: "C:/xfer-in/abc.bin" };
  ui.initXferUi({
    core: {},
    invoke: async (cmd, args) => {
      if (cmd === "xfer_offer") { offers.push(args.path); const h = args.path.includes("big") ? "cd" : "ef"; return enc({ ...tk, hash: h.repeat(32), name: args.path.includes("big") ? "big.bin" : "other.bin", size: THRESHOLD + 1 }); }
      if (cmd === "xfer_fetch") return fetchResult;
      return null;
    },
    sendText: async (chatId, text) => texts.push({ chatId, text }),
    sendFile: async (chatId, path, name) => files.push({ chatId, path, name }),
    metadata: async () => ({ "a@relay.example": { iroh_relay: "https://iroh.relay.example/" } }),
  });

  // Sender: over threshold to a same-relay peer routes; the card is mailed.
  const peer = "b@relay.example";
  assert.equal(await ui.peerIsVelta(peer), true);
  assert.equal(await ui.peerIsVelta("z@else.example"), false, "foreign relay is not a Velta peer (v1 heuristic)");
  const out = await ui.maybeSend({ chatId: 5, path: "C:/dl/big.bin", name: "big.bin", size: THRESHOLD + 1, oneToOne: true, peerAddr: peer });
  assert.equal(out.handled, true);
  assert.equal(offers[0], "C:/dl/big.bin");
  const cardText = texts[0].text;
  assert.match(cardText, /^📎 big\.bin/);
  assert.match(cardText, /^VXFER1:/m);

  // Sender's bubble: outgoing card shows the iroh route, no actions.
  ui.noteCard(5, cardText, true);
  const outHtml = ui.xferCardHtml(cardText);
  assert.match(outHtml, /Sent directly \(iroh\)/);
  assert.doesNotMatch(outHtml, /xfer-ask|Received/);

  // Receiver: first render kicks the fetch; success lands Open + Received.
  // (A different device's offer carries its own hash — separate state entry.)
  const rText = `📎 got.bin · 6.7 MB — sent directly from device to device\n${enc({ ...tk, hash: "aa".repeat(32), name: "got.bin" })}`;
  ui.noteCard(9, rText, false);
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  const rHtml = ui.xferCardHtml(rText);
  assert.match(rHtml, /Received/);
  assert.match(rHtml, /xfer-open/);
  assert.match(rHtml, /got\.bin/);

  // Receiver: fetch that wants email sends the fallback request, label flips.
  fetchResult = { error: "Expired", email: true };
  const out3 = await ui.maybeSend({ chatId: 5, path: "C:/dl/other.bin", name: "other.bin", size: THRESHOLD + 1, oneToOne: true, peerAddr: peer });
  assert.equal(out3.handled, true);
  const t2 = enc({ ...tk, name: "late.bin", hash: "ef".repeat(32) });
  const late = `📎 late.bin · 6.7 MB — sent directly from device to device\n${t2}`;
  ui.noteCard(9, late, false);
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  assert.match(texts.at(-1).text, /^VXFER-RESEND:/);
  assert.match(ui.xferCardHtml(late), /Asked for the email copy/);

  // Sender: the fallback request mails the pending file exactly once.
  assert.equal(await ui.xferCardHtml !== null, true);
  const resend = resendRequestText("ef".repeat(32));
  ui.noteCard(5, resend, false);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(files, [{ chatId: 5, path: "C:/dl/other.bin", name: "other.bin" }]);
  ui.noteCard(5, resend, false);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(files.length, 1, "only once");

  // Under threshold / group / non-Velta: the caller sends normally.
  const out2 = await ui.maybeSend({ chatId: 5, path: "C:/dl/small.txt", name: "small.txt", size: 100, oneToOne: true, peerAddr: peer });
  assert.equal(out2.handled, false);
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
