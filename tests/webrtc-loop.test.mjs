// #468: PWA Loop over WebRTC — the pure parts of app/js/webrtc-loop.js.
// The real two-browser run is scripts/e2e-webrtc-loop.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  sdpFingerprint, decodeSignal, makeSignal, fingerprintMatches, encodeChunk, decodeChunk,
  memorySink, MEM_CAP, loopOptIn, setLoopOptIn, createXdcSignal, LoopLink, stateText,
} from "../app/js/webrtc-loop.js";

const FP_A = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
const FP_B = FP_A.replace(/^AB/, "00");
const sdp = (fp, n = 1) => ["v=0", "o=- 1 2 IN IP4 127.0.0.1", ...Array.from({ length: n }, () => `a=fingerprint:sha-256 ${fp}`), ""].join("\r\n");

test("sdpFingerprint: one normalized fingerprint, null for none or conflicting", () => {
  assert.equal(sdpFingerprint(sdp(FP_A.toLowerCase())), `sha-256 ${FP_A}`);
  assert.equal(sdpFingerprint(sdp(FP_A, 2)), `sha-256 ${FP_A}`, "same fp per m-section is fine");
  assert.equal(sdpFingerprint(sdp(FP_A) + `a=fingerprint:sha-256 ${FP_B}\r\n`), null);
  assert.equal(sdpFingerprint("v=0\r\n"), null);
});

test("signals: shape is validated and the fingerprint rides next to the SDP", () => {
  const s = makeSignal("offer", "alice@x", "0123456789abcdef", sdp(FP_A));
  assert.equal(s.fp, `sha-256 ${FP_A}`);
  assert.deepEqual(decodeSignal(s), s);
  assert.equal(decodeSignal({ ...s, vlw: 2 }), null);
  assert.equal(decodeSignal({ ...s, t: "ice" }), null, "non-trickle: no ice type");
  assert.equal(decodeSignal({ ...s, sid: "x" }), null);
  assert.equal(decodeSignal({ ...s, fp: undefined }), null);
  assert.ok(decodeSignal(makeSignal("bye", "alice@x", "0123456789abcdef")));
  assert.ok(fingerprintMatches(s.sdp, s.fp));
  assert.ok(!fingerprintMatches(sdp(FP_B), s.fp), "a swapped SDP no longer matches the pin");
});

test("a signal whose SDP does not match its pinned fingerprint is refused before any WebRTC", async () => {
  let made = 0;
  const states = [];
  const link = new LoopLink({ selfId: "bob@x", peerId: "alice@x", sendSignal: async () => {},
    RTCPeerConnection: class { constructor() { made++; } }, onState: (s, r) => states.push([s, r]) });
  const forged = { ...makeSignal("offer", "alice@x", "0123456789abcdef", sdp(FP_A)), sdp: sdp(FP_B) };
  assert.equal(await link.handleSignal(forged), true);
  assert.equal(made, 0);
  assert.deepEqual(states.at(-1), ["failed", "pin"]);
  assert.equal(await link.handleSignal(makeSignal("offer", "eve@x", "0123456789abcdef", sdp(FP_A))), false, "other senders are ignored");
});

test("chunks round-trip and reject junk", () => {
  const c = encodeChunk("0011223344556677", new Uint8Array([1, 2, 3]));
  const d = decodeChunk(c.buffer);
  assert.equal(d.id, "0011223344556677");
  assert.deepEqual([...d.bytes], [1, 2, 3]);
  assert.equal(decodeChunk(new Uint8Array([0, 1])), null);
  assert.equal(decodeChunk(new Uint8Array([9, 1])), null);
});

test("memory sink enforces the cap up front and while writing", async () => {
  assert.throws(() => memorySink({ size: MEM_CAP + 1 }), (e) => e.code === "too-big");
  const s = memorySink({ size: 4, mime: "text/plain" }, 4);
  await s.write(new Uint8Array([104, 105]));
  await s.write(new Uint8Array([33, 33]));
  await assert.rejects(s.write(new Uint8Array([1])), (e) => e.code === "too-big");
});

test("opt-in is per contact and off by default", () => {
  const m = new Map();
  const store = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  assert.equal(loopOptIn(store, "a@x"), false);
  setLoopOptIn(store, "a@x", true);
  assert.equal(loopOptIn(store, "a@x"), true);
  assert.equal(loopOptIn(store, "b@x"), false);
  setLoopOptIn(store, "a@x", false);
  assert.equal(loopOptIn(store, "a@x"), false);
});

test("xdc signaling: silent status updates, own and foreign junk dropped", async () => {
  const sent = [];
  const got = [];
  const core = { sendWebxdcStatusUpdate: async (id, str, descr) => sent.push([id, JSON.parse(str), descr]) };
  const sig = createXdcSignal({ core, msgId: 9, selfId: "bob@x", onSignal: (s) => got.push(s) });
  const offer = makeSignal("offer", "alice@x", "0123456789abcdef", sdp(FP_A));
  await sig.send(offer);
  assert.equal(sent[0][0], 9);
  assert.deepEqual(sent[0][1], { payload: { veltaLoop: offer } });
  assert.equal(sent[0][1].info, undefined, "no info line: nothing shows in the chat");
  sig.ingest([{ payload: { veltaLoop: offer } }, { payload: { veltaLoop: { ...offer, from: "bob@x" } } }, { payload: { veltaCall: {} } }, null]);
  assert.equal(got.length, 1);
  assert.equal(got[0].from, "alice@x");
});

test("failure text never shows an address and names the isolation case", () => {
  const s = stateText("failed", "network");
  assert.match(s, /guest Wi-Fi/);
  assert.doesNotMatch(s, /\d+\.\d+\.\d+\.\d+/);
});
