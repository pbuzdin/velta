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

## Signaling — `app/js/group-call-signal.js` + host session `app/js/group-call-host.js` (Phase 2)

- One webxdc instance (the group-call app message) = one call room.
  Messages `{vgc:1, t: join|leave|hb|offer|answer, from, sid, ts, …}`.
- **Status updates** (`payload.veltaCall`): roster (join/leave), the chat
  info line (only "X started a group call" for the first joiner and
  "Group call ended" for the last leaver), `summary` "Group call · N in
  call", SDP for pairs where either side lacks realtime (the wasm PWA), and
  every offer retry (`try >= 2`); an answer goes the way its offer came.
  These rows stay in the chat history (accepted by Pavel).
- **Realtime** (iroh gossip): SDP between realtime peers and 15 s
  heartbeats; frames are `"VGC1" + JSON`. KEEP: webxdc-manager routes
  every VGC1 frame to the host (`routeRealtime`) and never to the app
  frame; closing the app frame or the app's own `realtimeLeave` does NOT
  leave the channel while a call holds that instance.
- Liveness: realtime members expire after 50 s of silence, status-update
  members after 240 s (they heartbeat via status update every 90 s, only
  when someone in the call lacks realtime); a member we have a connected
  peer connection to never expires. History replay uses the sender's `ts`,
  so a newcomer ignores an old call. Offers/answers in the history are
  never replayed.
- `from` is self-declared (core gives no sender on either transport);
  the DTLS fingerprint in the SDP authenticates the media session.
- `GroupCallSession` (one at a time, `joinGroupCall`/`leaveGroupCall`):
  reads the history first (the cap needs it), advertises on realtime
  (failure → status updates only), opens the mic, posts the join; owns
  hidden `<audio>` elements per peer; Android audio route + wake lock via
  injected env. The call outlives the app frame.

Tests: `tests/group-call-signal.test.mjs`, `tests/group-call-host.test.mjs`;
`scripts/e2e-group-call.mjs` second part: three `GroupCallSession`s
(desktop + Android with realtime, PWA without) over a shared fake chat in
Chromium, relay-only through coturn.
