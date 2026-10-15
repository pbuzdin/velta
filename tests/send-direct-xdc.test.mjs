import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import vm from "node:vm";

const T = await import("../app/webxdc/send-direct/transfer.js");
const { buildSendDirect, classicTransfer } = await import("../tools/build-builtin-xdc.mjs");

test("sha256Hex matches node crypto across block boundaries", () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70000]) {
    const b = randomBytes(n);
    assert.equal(T.sha256Hex(new Uint8Array(b)), createHash("sha256").update(b).digest("hex"), `len ${n}`);
  }
});

test("frames round-trip and garbage decodes to null", () => {
  const p = new Uint8Array([1, 2, 3]);
  const f = T.decodeFrame(T.encodeFrame(T.T_CHUNK, { id: "ab", i: 4 }, p));
  assert.equal(f.type, T.T_CHUNK);
  assert.deepEqual(f.header, { id: "ab", i: 4 });
  assert.deepEqual([...f.payload], [1, 2, 3]);
  assert.equal(T.decodeFrame(new Uint8Array([3, 0, 0, 0, 99])), null);
  assert.equal(T.decodeFrame(new Uint8Array([1])), null);
  // largest chunk frame stays under the spec's 128 000-byte realtime limit
  const big = T.encodeFrame(T.T_CHUNK, { id: "0123456789abcdef", i: 999999 }, new Uint8Array(T.CHUNK));
  assert.ok(big.length < 128000, String(big.length));
});

// Gossip simulation: broadcast to every other peer, with message loss.
function net(lossEvery = 0) {
  const peers = [];
  let count = 0;
  return {
    peer(onFrame) {
      const me = { onFrame };
      peers.push(me);
      me.send = (bytes) => {
        count++;
        if (lossEvery && count % lossEvery === 0) return; // dropped
        for (const p of peers) if (p !== me) p.queue.push(bytes.slice());
      };
      me.queue = [];
      return me;
    },
    run(steps, tick) {
      for (let s = 0; s < steps; s++) {
        let moved = true;
        while (moved) {
          moved = false;
          for (const p of peers) while (p.queue.length) { moved = true; p.onFrame(T.decodeFrame(p.queue.shift())); }
        }
        tick?.();
      }
    },
  };
}

test("two receivers get the file over a lossy channel, sha256 verified", () => {
  let now = 0;
  const clock = () => now;
  const bytes = new Uint8Array(randomBytes(T.CHUNK * 5 + 777));
  const n = net(7);
  let sender, r1, r2;
  const ps = n.peer((f) => sender.handle(f));
  sender = new T.Sender({ name: "pic.jpg", bytes, send: ps.send, now: clock });
  assert.ok(T.validOffer(sender.offer));
  const p1 = n.peer((f) => r1.handle(f));
  const p2 = n.peer((f) => r2.handle(f));
  r1 = new T.Receiver({ offer: sender.offer, send: p1.send, now: clock });
  r2 = new T.Receiver({ offer: sender.offer, send: p2.send, now: clock });
  r1.pump(); r2.pump();
  n.run(60, () => { now += 2000; r1.pump(); r2.pump(); });
  for (const r of [r1, r2]) {
    assert.equal(r.done, true);
    assert.equal(r.ok, true);
    assert.deepEqual(Buffer.from(r.bytes), Buffer.from(bytes));
  }
});

test("a tampered chunk fails the checksum; wrong-size chunks are ignored", () => {
  const bytes = new Uint8Array(randomBytes(100));
  const s = new T.Sender({ name: "x", bytes, send() {}, chunk: 40 });
  const r = new T.Receiver({ offer: s.offer, send() {} });
  const mk = (i, data) => T.decodeFrame(T.encodeFrame(T.T_CHUNK, { id: s.offer.id, i }, data));
  assert.equal(r.handle(mk(0, new Uint8Array(39))), false);
  r.handle(mk(0, bytes.subarray(0, 40)));
  const evil = bytes.slice(40, 80); evil[0] ^= 1;
  r.handle(mk(1, evil));
  r.handle(mk(2, bytes.subarray(80)));
  assert.equal(r.done, true);
  assert.equal(r.ok, false);
});

test("sender ignores foreign ids, bad indices, and de-dupes bursts", () => {
  let now = 0;
  const out = [];
  const s = new T.Sender({ name: "x", bytes: new Uint8Array(100), send: (b) => out.push(b), chunk: 40, now: () => now });
  const req = (id, idx) => T.decodeFrame(T.encodeFrame(T.T_REQ, { id, idx }));
  s.handle(req("ffffffffffffffff", [0]));
  s.handle(req(s.offer.id, [-1, 3, 1.5, "0"]));
  assert.equal(out.length, 0);
  s.handle(req(s.offer.id, [0, 1]));
  s.handle(req(s.offer.id, [0, 1])); // second receiver, same moment
  assert.equal(out.length, 2);
  now = 1000;
  s.handle(req(s.offer.id, [0]));
  assert.equal(out.length, 3);
});

test("validOffer rejects inconsistent or hostile offers", () => {
  const ok = { id: "0123456789abcdef", name: "a", size: 100, chunk: 40, n: 3, sha256: "a".repeat(64) };
  assert.ok(T.validOffer(ok));
  assert.ok(!T.validOffer({ ...ok, n: 2 }));
  assert.ok(!T.validOffer({ ...ok, chunk: 1e6 }));
  assert.ok(!T.validOffer({ ...ok, id: "<script>" }));
  assert.ok(!T.validOffer({ ...ok, name: "" }));
});

test("committed send-direct.xdc is up to date with its sources", () => {
  const committed = readFileSync(new URL("../app/builtin/send-direct.xdc", import.meta.url));
  assert.ok(buildSendDirect().equals(committed), "run: node tools/build-builtin-xdc.mjs");
  const main = classicTransfer(readFileSync(new URL("../app/webxdc/send-direct/transfer.js", import.meta.url), "utf8"));
  const sandbox = { window: {}, TextEncoder, TextDecoder, crypto: globalThis.crypto };
  vm.runInNewContext(main, sandbox);
  for (const k of ["Sender", "Receiver", "decodeFrame", "encodeFrame", "validOffer", "T_OFFER", "T_REQ", "T_CHUNK"]) {
    assert.ok(sandbox.window.Transfer[k] !== undefined, k);
  }
});

// The injected shim: joinRealtimeChannel over the postMessage bridge.
function loadShim() {
  const posted = [];
  const listeners = [];
  const win = {
    addEventListener: (t, f) => { if (t === "message") listeners.push(f); },
    parent: { postMessage: (m) => posted.push(m) },
    localStorage: { getItem() { return null; } }, sessionStorage: { getItem() { return null; } },
  };
  const ctx = { window: win, location: { search: "" }, document: { documentElement: { style: {} } }, URLSearchParams, Map, Promise, Uint8Array, Blob: class {}, atob, console };
  win.window = win;
  vm.runInNewContext(readFileSync(new URL("../velta-app/src-tauri/src/webxdc-shim.js", import.meta.url), "utf8"), ctx);
  const deliver = (data) => listeners.forEach(f => f({ data }));
  const answer = () => { for (const m of posted) if (m.id && m.id !== "info" && !m.answered) { m.answered = true; deliver({ type: "velta-webxdc-response", id: m.id, result: {} }); } };
  return { wx: win.webxdc, posted, deliver, answer };
}

test("shim: joinRealtimeChannel joins, sends after join, delivers, leaves", async () => {
  const { wx, posted, deliver, answer } = loadShim();
  const ch = wx.joinRealtimeChannel();
  assert.throws(() => wx.joinRealtimeChannel(), /already joined/);
  const got = [];
  ch.setListener((d) => got.push([...d]));
  ch.send(new Uint8Array([7, 8]));
  assert.throws(() => ch.send([1]), /Uint8Array/);
  assert.throws(() => ch.send(new Uint8Array(128001)), /too large/);
  assert.deepEqual(posted.filter(m => m.method).map(m => m.method), ["getInfo", "realtimeJoin"]);
  answer(); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  const sendMsg = posted.find(m => m.method === "realtimeSend");
  assert.ok(sendMsg, "send queued until join resolved");
  assert.deepEqual([...sendMsg.params.data], [7, 8]);
  deliver({ type: "velta-webxdc-realtime", data: new Uint8Array([1, 2]) });
  assert.deepEqual(got, [[1, 2]]);
  ch.leave();
  deliver({ type: "velta-webxdc-realtime", data: new Uint8Array([3]) });
  assert.equal(got.length, 1);
  assert.ok(posted.some(m => m.method === "realtimeLeave"));
  assert.doesNotThrow(() => wx.joinRealtimeChannel()); // may re-join after leave
});

test("host wiring: realtime methods, events and leave-on-close", () => {
  const mgr = readFileSync(new URL("../app/js/webxdc-manager.js", import.meta.url), "utf8");
  for (const s of ['case "realtimeJoin"', 'case "realtimeSend"', 'case "realtimeLeave"', "sendWebxdcRealtimeAdvertisement(msgId)",
    "sendWebxdcRealtimeData(msgId, Array.from(bytes))", '"webxdc-realtime-data"', "leaveWebxdcRealtime?.(active.msgId)"]) {
    assert.ok(mgr.includes(s), s);
  }
  const rpc = readFileSync(new URL("../app/js/rpc-core.js", import.meta.url), "utf8");
  assert.match(rpc, /case "WebxdcRealtimeData":/);
  assert.match(rpc, /"send_webxdc_realtime_advertisement"/);
  const mock = readFileSync(new URL("../app/js/mock-core.js", import.meta.url), "utf8");
  assert.match(mock, /async sendWebxdcRealtimeAdvertisement\(/);
  const cv = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  assert.match(cv, /label: "Velta Beam \(both online\)"/);
});

test("receiver progress: frames, tracker percent/done/stale/drop", () => {
  let now = 0;
  const bytes = new Uint8Array(randomBytes(T.CHUNK * 3 + 5));
  const s = new T.Sender({ name: "f", bytes, send() {} });
  const r = new T.Receiver({ offer: s.offer, send() {} });
  const frame = T.progressFrame(r, "bob@x.org", "Bob ".repeat(40));
  assert.ok(frame.length < 1000);
  const h = T.decodeFrame(frame).header;
  assert.equal(h.name.length, 64);
  assert.ok(T.validProgress(h));
  assert.equal(T.validProgress({ ...h, have: 99 }), false);

  const t = new T.ReceiverTracker({ id: s.offer.id, now: () => now });
  const prog = (peer, have, done = false, ok = null) =>
    T.decodeFrame(T.encodeFrame(T.T_PROG, { id: s.offer.id, peer, name: peer.split("@")[0], have, n: 4, done, ok }));
  assert.equal(t.handle(T.decodeFrame(T.encodeFrame(T.T_PROG, { ...h, id: "ffffffffffffffff" }))), false);
  t.handle(prog("a@x", 2)); t.handle(prog("b@x", 0)); t.handle(prog("c@x", 4, true, true));
  assert.equal(t.activeCount(), 3);
  assert.deepEqual(t.list().map(p => [p.peer, p.percent, p.done, p.stale]),
    [["a@x", 50, false, false], ["b@x", 0, false, false], ["c@x", 100, true, false]]);
  t.handle(prog("a@x", 1)); // reordered/lost frames never move progress back
  assert.equal(t.list()[0].percent, 50);
  now = 11000;
  const l = t.list();
  assert.deepEqual(l.map(p => [p.peer, p.stale]), [["a@x", true], ["c@x", false]]); // b dropped, a stale, c done
  assert.equal(t.activeCount(), 0);
  t.handle(prog("a@x", 3));
  assert.equal(t.list()[0].stale, false);
});

test("ui wires progress broadcast and the receiver list", () => {
  const ui = readFileSync(new URL("../app/webxdc/send-direct/ui.js", import.meta.url), "utf8");
  for (const s of ["Transfer.T_PROG", "Transfer.progressFrame(o.rx, myPeer(), myName())", "Transfer.PROG_MS", "receiver${n === 1 ? \"\" : \"s\"}", 'aria-label="Receivers"']) assert.ok(ui.includes(s), s);
  const main = classicTransfer(readFileSync(new URL("../app/webxdc/send-direct/transfer.js", import.meta.url), "utf8"));
  for (const n of ["T_PROG", "PROG_MS", "SILENT_MS", "ReceiverTracker", "progressFrame", "validProgress"]) assert.match(main, new RegExp(`window\\.Transfer = \\{[^}]*\\b${n}\\b`));
});
