// call-route.js — is the call's media flowing directly between the devices
// or through a TURN relay (#239)? Pure parsing of an RTCStatsReport so it
// runs headless in tests; calls.js polls getStats() and renders the chip.
//
// Selected pair: transport.selectedCandidatePairId (Chromium, WebKit), else
// a candidate-pair with selected:true (Firefox), else the nominated
// succeeded pair. Either side being a "relay" candidate = via relay;
// host / srflx / prflx on both sides = direct. A relay is normal, and the
// media is end-to-end encrypted (DTLS-SRTP) either way.

function statsList(report) {
  if (!report) return [];
  if (Array.isArray(report)) return report;
  const out = [];
  if (typeof report.forEach === "function") report.forEach((s) => out.push(s));
  else if (typeof report.values === "function") for (const s of report.values()) out.push(s);
  return out.filter((s) => s && typeof s === "object");
}

// → null (no selected pair yet / no stats) or
//   { kind: "direct"|"relay", local, remote, protocol, rttMs, pairId }
export function parseCallRoute(report) {
  const list = statsList(report);
  if (!list.length) return null;
  const byId = new Map(list.map((s) => [s.id, s]));
  let pair = null;
  for (const s of list) {
    if (s.type === "transport" && s.selectedCandidatePairId && byId.get(s.selectedCandidatePairId)) {
      pair = byId.get(s.selectedCandidatePairId);
      break;
    }
  }
  if (!pair) pair = list.find((s) => s.type === "candidate-pair" && s.selected === true) || null;
  if (!pair) pair = list.find((s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded") || null;
  if (!pair) return null;
  const lc = byId.get(pair.localCandidateId);
  const rc = byId.get(pair.remoteCandidateId);
  const local = lc?.candidateType || "";
  const remote = rc?.candidateType || "";
  if (!local && !remote) return null;
  const kind = local === "relay" || remote === "relay" ? "relay" : "direct";
  // To the relay itself: relayProtocol (udp/tcp/tls); else the pair's transport.
  const protocol = String((local === "relay" && lc?.relayProtocol) || lc?.protocol || "").toLowerCase();
  const rtt = Number(pair.currentRoundTripTime);
  const rttMs = Number.isFinite(rtt) && rtt >= 0 ? Math.round(rtt * 1000) : null;
  return { kind, local, remote, protocol, rttMs, pairId: pair.id || "" };
}

// A switch worth highlighting: we had a route and its kind changed.
export function routeSwitched(prev, next) {
  return !!(prev && next && prev.kind !== next.kind);
}
