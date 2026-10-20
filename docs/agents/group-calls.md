# Group audio calls — agent notes

Design: [`../research/webxdc-group-calls.md`](../research/webxdc-group-calls.md)
(decisions 2026-10-20: Velta runs the call, the app only gets
`webxdc.veltaCall`; cap 6; full mesh, no media server; relay-only;
trust = built-in hash list only; PWA via status-update signaling).

## Media — `app/js/group-call.js` (Phase 1)

- `GroupCall`: one `RTCPeerConnection` per remote participant, audio only,
  mic with echo cancellation/NS/AGC, mono. Opus tuned in the SDP
  (`tuneOpus`: 32 kbps, DTX, in-band FEC).
- KEEP: `iceTransportPolicy: "relay"` by default (peers never learn each
  other's IP). `relayOnly:false` exists only for an explicit opt-in.
- Pair rule: the smaller id offers (`isOfferer`); exactly one offer + one
  answer per pair, non-trickle ICE (gather ≤ 3 s) so it also works over
  slow status updates. Unanswered offers are resent (7 s, 4 tries); a
  duplicate offer gets the same answer again (it may arrive over both
  transports). ICE `failed` → rebuild the pair (≤ 3 times).
- Cap: `admitted(roster)` = first 6 by join time (`at`, ties by id); every
  client computes the same set. Later joiners get state `"full"` and
  connect to nobody until someone leaves.
- Negotiated data channel id 3 `"state"` carries `{muted}`. Mute only flips
  `track.enabled` (KEEP, like 1:1 calls).
- Levels: `getStats()` `inbound-rtp.audioLevel` per peer and
  `media-source.audioLevel` for self every 300 ms → `speaking` (> 0.04)
  and `activeSpeaker` in `snapshot()`.
- A roster entry with a new `sid` (rejoin) replaces the old connection.

Tests: `tests/group-call.test.mjs` (fake WebRTC);
`scripts/e2e-group-call.mjs` — N (default 4) Chromium pages, fake mics,
real WebRTC, **relay-only through a local coturn** when `turnserver` is on
PATH (else host candidates, printed): mesh connected with audio bytes both
ways on every pair, selected candidates are `relay`, mute propagates,
levels reported, leaver dropped, 6 connect, 7th is `full`.
