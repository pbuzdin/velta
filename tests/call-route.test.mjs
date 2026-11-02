import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCallRoute, routeSwitched } from "../app/js/call-route.js";
import { netRouteDetail, netRouteLabel } from "../app/js/calls.js";

// #239: Direct vs Via relay chip in the call screen, from getStats().

const cand = (id, candidateType, extra = {}) => ({ id, type: "local-candidate", candidateType, protocol: "udp", ...extra });
const rcand = (id, candidateType) => ({ id, type: "remote-candidate", candidateType, protocol: "udp" });
const report = (local, remote, pair = {}) => new Map(Object.entries({
  T1: { id: "T1", type: "transport", selectedCandidatePairId: "P1" },
  P1: { id: "P1", type: "candidate-pair", localCandidateId: "L1", remoteCandidateId: "R1", state: "succeeded", nominated: true, currentRoundTripTime: 0.042, ...pair },
  P0: { id: "P0", type: "candidate-pair", localCandidateId: "L0", remoteCandidateId: "R1", state: "failed" },
  L0: cand("L0", "host"),
  L1: local,
  R1: rcand("R1", remote),
}));

test("relay: local relay candidate → via relay, relayProtocol and RTT", () => {
  const r = parseCallRoute(report(cand("L1", "relay", { relayProtocol: "tls", protocol: "udp" }), "srflx"));
  assert.deepEqual(r, { kind: "relay", local: "relay", remote: "srflx", protocol: "tls", rttMs: 42, pairId: "P1" });
  assert.equal(parseCallRoute(report(cand("L1", "host"), "relay")).kind, "relay", "remote relay counts too");
});

test("direct host pair", () => {
  const r = parseCallRoute(report(cand("L1", "host"), "host"));
  assert.equal(r.kind, "direct");
  assert.equal(r.protocol, "udp");
});

test("srflx and prflx are direct", () => {
  assert.equal(parseCallRoute(report(cand("L1", "srflx"), "srflx")).kind, "direct");
  assert.equal(parseCallRoute(report(cand("L1", "prflx", { protocol: "TCP" }), "host")).protocol, "tcp");
});

test("Firefox: selected:true pair without transport stats; arrays work", () => {
  const list = [...report(cand("L1", "relay"), "host").values()].filter((s) => s.type !== "transport");
  list.find((s) => s.id === "P1").selected = true;
  assert.equal(parseCallRoute(list).kind, "relay");
});

test("missing stats → null (chip stays hidden)", () => {
  assert.equal(parseCallRoute(null), null);
  assert.equal(parseCallRoute(new Map()), null);
  assert.equal(parseCallRoute([{ id: "P", type: "candidate-pair", state: "in-progress" }]), null);
  const noRtt = parseCallRoute(report(cand("L1", "host"), "host", { currentRoundTripTime: undefined }));
  assert.equal(noRtt.rttMs, null);
});

test("route switch detection", () => {
  const relay = parseCallRoute(report(cand("L1", "relay"), "host"));
  const direct = parseCallRoute(report(cand("L1", "host"), "host"));
  assert.equal(routeSwitched(relay, direct), true);
  assert.equal(routeSwitched(direct, relay), true);
  assert.equal(routeSwitched(direct, { ...direct, rttMs: 5 }), false);
  assert.equal(routeSwitched(null, direct), false, "first route is not a switch");
});

test("labels, detail and locales", () => {
  assert.equal(netRouteLabel({ kind: "relay" }), "Via relay");
  assert.equal(netRouteLabel({ kind: "direct" }), "Direct");
  const d = netRouteDetail({ kind: "relay", local: "relay", remote: "host", protocol: "udp", rttMs: 80 });
  assert.deepEqual(d.slice(0, 3), ["Candidates: relay / host", "Protocol: UDP", "Round trip: 80 ms"]);
  assert.match(d[3], /end-to-end encrypted/);
  const keys = ["Direct", "Via relay", "Candidates: {local} / {remote}", "Protocol: {protocol}", "Round trip: {ms} ms",
    "Relayed calls are normal and still end-to-end encrypted.", "Media goes straight between the devices, end-to-end encrypted."];
  for (const l of ["ru", "fr"]) {
    const j = JSON.parse(readFileSync(new URL(`../app/locales/${l}.json`, import.meta.url), "utf8"));
    for (const k of keys) assert.ok(j[k], `${l}: ${k}`);
  }
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  assert.match(css, /\.call-net-chip \{/);
});
