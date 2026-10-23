// Velta Beam group fan-out (transfer.js): seeder scheduling, cross-seeder
// dedupe, per-piece verification, and a lossy multi-peer simulation.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const T = await import("../app/webxdc/send-direct/transfer.js");
const req = (id, idx) => T.decodeFrame(T.encodeFrame(T.T_REQ, { id, idx }));
const chunks = (out) => out.map((b) => T.decodeFrame(b)).filter((f) => f.type === T.T_CHUNK);

test("offer carries per-piece hashes; validOffer checks them", () => {
  const bytes = new Uint8Array(randomBytes(250));
  const s = new T.Sender({ name: "a", bytes, send() {}, chunk: 100 });
  assert.equal(s.offer.ph.length, 3);
  assert.ok(T.validOffer(s.offer));
  assert.ok(!T.validOffer({ ...s.offer, ph: s.offer.ph.slice(1) }));
  assert.ok(!T.validOffer({ ...s.offer, ph: ["zz", ...s.offer.ph.slice(1)] }));
  const { ph, ...noPh } = s.offer;
  assert.ok(T.validOffer(noPh), "old offers without ph stay valid");
  // past PH_MAX pieces the offer has no ph (offer frame stays under the cap)
  assert.equal(T.pieceHashes(new Uint8Array(T.PH_MAX + 1), 1), null);
  const big = T.encodeFrame(T.T_OFFER, { ...s.offer, ph: new Array(T.PH_MAX).fill("a".repeat(32)) });
  assert.ok(big.length < 128000, String(big.length));
});

test("sender coalesces requests from several receivers into one send per round", () => {
  let now = 0; const out = [];
  const s = new T.Sender({ name: "x", bytes: new Uint8Array(400), send: (b) => out.push(b), chunk: 100, now: () => now });
  s.handle(req(s.offer.id, [0, 1, 2]));
  s.handle(req(s.offer.id, [0, 1, 2, 3])); // receiver B, same round
  s.handle(req(s.offer.id, [1, 3]));       // receiver C
  assert.deepEqual(chunks(out).map((f) => f.header.i), [0, 1, 2, 3]);
  now = 500; s.handle(req(s.offer.id, [0])); assert.equal(chunks(out).length, 4, "same round");
  now = 1100; s.handle(req(s.offer.id, [0])); assert.equal(chunks(out).length, 5, "next round");
});

test("non-source seeder waits a jitter and drops a piece someone else sent", () => {
  let now = 0; const out = [];
  const bytes = new Uint8Array(300);
  const sd = new T.Seeder({ offer: { id: "0123456789abcdef", n: 3 }, piece: (i) => bytes.subarray(i * 100, i * 100 + 100), send: (b) => out.push(b), now: () => now, rand: () => 0.5, jitterMs: 200 });
  sd.handle(req("0123456789abcdef", [0, 1, 2]));
  assert.equal(out.length, 0, "jittered, not immediate");
  sd.noteChunk(1); // another seeder answered piece 1
  now = 150; sd.flush();
  assert.deepEqual(chunks(out).map((f) => f.header.i), [0, 2]);
});

test("seeder only serves pieces it holds; rate limit spreads a burst", () => {
  let now = 0; const out = [];
  const sd = new T.Seeder({ offer: { id: "0123456789abcdef", n: 64 }, piece: (i) => (i % 2 ? null : new Uint8Array(10)), send: (b) => out.push(b), now: () => now, source: true, rate: 10 });
  sd.handle(req("0123456789abcdef", Array.from({ length: 64 }, (_, i) => i)));
  assert.equal(chunks(out).length, 10, "burst capped at rate");
  assert.ok(chunks(out).every((f) => f.header.i % 2 === 0));
  now = 1000; sd.flush();
  assert.equal(chunks(out).length, 20);
  for (now = 2000; now <= 4000; now += 1000) sd.flush();
  assert.equal(chunks(out).length, 32, "all held pieces served, none of the missing");
});

test("receiver rejects a piece failing its hash, keeps asking, seeds verified pieces only", () => {
  const bytes = new Uint8Array(randomBytes(300));
  const s = new T.Sender({ name: "x", bytes, send() {}, chunk: 100 });
  const r = new T.Receiver({ offer: s.offer, send() {} });
  const mk = (i, data) => T.decodeFrame(T.encodeFrame(T.T_CHUNK, { id: s.offer.id, i }, data));
  const evil = bytes.slice(0, 100); evil[3] ^= 1;
  assert.equal(r.handle(mk(0, evil)), false);
  assert.equal(r.rejected, 1);
  assert.equal(r.piece(0), null);
  assert.equal(r.handle(mk(1, bytes.subarray(100, 200))), true);
  assert.ok(r.canSeed, "partial seeder with per-piece hashes");
  assert.deepEqual([...r.piece(1)], [...bytes.subarray(100, 200)]);
  // without ph: no partial seeding, only after the full hash matches
  const { ph, ...noPh } = s.offer;
  const r2 = new T.Receiver({ offer: noPh, send() {} });
  r2.handle(mk(0, bytes.subarray(0, 100)));
  assert.equal(r2.canSeed, false);
  assert.equal(r2.piece(0), null);
  r2.handle(mk(1, bytes.subarray(100, 200))); r2.handle(mk(2, bytes.subarray(200)));
  assert.ok(r2.ok && r2.canSeed && r2.piece(2).length === 100);
});

test("receiver re-asks with exponential backoff", () => {
  let now = 0; const asks = [];
  const r = new T.Receiver({ offer: { id: "0123456789abcdef", n: 1, size: 5, chunk: 5 }, send: (b) => asks.push(now), now: () => now, retryMs: 1000, rand: () => 0 });
  for (now = 0; now <= 20000; now += 100) r.pump();
  assert.deepEqual(asks, [0, 1000, 3000, 7000, 15000]);
});

test("tracker separates receivers from seeders and hides the source from the receiver list", () => {
  let now = 0;
  const tr = new T.ReceiverTracker({ id: "0123456789abcdef", now: () => now });
  const prog = (h) => T.decodeFrame(T.encodeFrame(T.T_PROG, { id: "0123456789abcdef", n: 4, ...h }));
  tr.handle(prog({ peer: "s", name: "Sam", have: 4, done: true, ok: true, seed: true, src: true }));
  tr.handle(prog({ peer: "a", name: "Ann", have: 4, done: true, ok: true, seed: true }));
  tr.handle(prog({ peer: "b", name: "Bob", have: 1, done: false, ok: null }));
  assert.deepEqual(tr.receivers().map((p) => p.name), ["Ann", "Bob"]);
  assert.deepEqual(tr.seeders().map((p) => p.name), ["Sam", "Ann"]);
  now = 20000;
  assert.deepEqual(tr.seeders(), [], "silent seeders are not shown as sharing");
});

// ---- simulated group: lossy broadcast channel, peers join and leave ----
function makeNet(loss, seed = 1) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const peers = new Set();
  let sent = 0, dropped = 0;
  return {
    rnd,
    stats: () => ({ sent, dropped }),
    join(onFrame) {
      const p = { onFrame, q: [] };
      p.send = (bytes) => {
        if (!peers.has(p)) return;
        sent++;
        if (bytes.length > 128000) throw new Error("frame over the realtime cap");
        for (const o of peers) if (o !== p) { if (rnd() < loss) { dropped++; continue; } o.q.push(bytes.slice()); }
      };
      peers.add(p);
      return p;
    },
    leave(p) { peers.delete(p); p.q.length = 0; },
    deliver() {
      let moved = true;
      while (moved) { moved = false; for (const p of [...peers]) while (p.q.length) { moved = true; p.onFrame(T.decodeFrame(p.q.shift())); } }
    },
  };
}

// The same wiring ui.js uses: REQ -> seeders, CHUNK -> noteChunk + receiver.
function member(net, clock, offer, { sender = null } = {}) {
  const m = { sender, rx: null, seed: null };
  m.p = net.join((f) => {
    if (!f) return;
    if (f.type === T.T_REQ) { m.sender?.handle(f); m.seed?.handle(f); }
    else if (f.type === T.T_CHUNK) { m.sender?.noteChunk(f.header.i); m.seed?.noteChunk(f.header.i); m.rx?.handle(f); }
  });
  if (sender) { sender.send = m.p.send; }
  else {
    m.rx = new T.Receiver({ offer, send: m.p.send, now: clock, rand: net.rnd });
    m.seed = new T.Seeder({ offer, send: m.p.send, now: clock, rand: net.rnd, piece: (i) => m.rx.piece(i) });
  }
  return m;
}

function run(net, members, ms, clockRef, until) {
  for (let t = 0; t < ms; t += 100) {
    clockRef.now += 100;
    for (const m of members()) { m.rx?.pump(); m.sender?.flush(); m.seed?.flush(); }
    net.deliver();
    if (until && until()) return true;
  }
  return until ? until() : true;
}

for (const withPh of [true, false]) {
  test(`1 sender + 3 receivers, 10% loss, late joiner after the sender left (${withPh ? "per-piece hashes" : "no ph"})`, () => {
    const clock = { now: 0 }; const now = () => clock.now;
    const net = makeNet(0.1, withPh ? 7 : 11);
    const bytes = new Uint8Array(randomBytes(T.CHUNK * 12 + 1234));
    const sender = new T.Sender({ name: "f.bin", bytes, send() {}, chunk: T.CHUNK, now, rand: net.rnd });
    if (!withPh) delete sender.offer.ph;
    const offer = JSON.parse(JSON.stringify(sender.offer)); // as received in the status update
    assert.ok(T.validOffer(offer));
    const s = member(net, now, offer, { sender });
    const a = member(net, now, offer), b = member(net, now, offer);
    let live = [s, a, b];
    const done = (...ms) => () => ms.every((m) => m.rx.done);
    assert.ok(run(net, () => live, 120000, clock, done(a, b)), "A and B finish");
    net.leave(s.p); live = [a, b];            // the sender closes Beam
    const c = member(net, now, offer);         // late joiner
    live = [a, b, c];
    const servedBefore = a.seed.served + b.seed.served;
    assert.ok(run(net, () => live, 120000, clock, done(c)), "late joiner finishes from seeders");
    for (const m of [a, b, c]) {
      assert.equal(m.rx.ok, true);
      assert.deepEqual(Buffer.from(m.rx.bytes), Buffer.from(bytes));
    }
    const served = a.seed.served + b.seed.served - servedBefore;
    // dedupe: two seeders, yet C cost little more than one copy (+ loss retries)
    assert.ok(served < offer.n * 2, `seeders sent ${served} pieces for ${offer.n}`);
  });
}

test("partial seeders alone can complete a newcomer (per-piece hashes)", () => {
  const clock = { now: 0 }; const now = () => clock.now;
  const net = makeNet(0.05, 3);
  const bytes = new Uint8Array(randomBytes(T.CHUNK * 6));
  const sender = new T.Sender({ name: "f", bytes, send() {}, now, rand: net.rnd });
  const offer = sender.offer;
  const a = member(net, now, offer), b = member(net, now, offer);
  // A holds pieces 0-3, B holds 2-5 (each verified on arrival)
  const give = (m, idx) => idx.forEach((i) => m.rx.handle(T.decodeFrame(T.encodeFrame(T.T_CHUNK, { id: offer.id, i }, bytes.subarray(i * T.CHUNK, (i + 1) * T.CHUNK)))));
  give(a, [0, 1, 2, 3]); give(b, [2, 3, 4, 5]);
  assert.ok(a.rx.done === false && b.rx.done === false);
  const c = member(net, now, offer);
  assert.ok(run(net, () => [a, b, c], 60000, clock, () => a.rx.done && b.rx.done && c.rx.done));
  for (const m of [a, b, c]) assert.equal(m.rx.ok, true);
});
