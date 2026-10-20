# Group audio calls — agent notes

Design: [`../research/webxdc-group-calls.md`](../research/webxdc-group-calls.md)
(decisions 2026-10-20: Velta runs the call, the app only gets
`webxdc.veltaCall`; cap 6; full mesh, no media server; relay-only;
trust = built-in hash list only; PWA via status-update signaling).

Velta Circle is the user-facing name of the built-in group call app
(`app/webxdc/group-call/`, `group-call.xdc`; path and file name kept — the
file name picks trust candidates for already-sent calls). Old bundle hashes
stay in `trusted-xdc.js`. Icon: `app/webxdc/group-call/icon.svg` (five dots
in a ring around the Velta Beam V without its bar; light-theme accent
#3390ec, white, 3.3:1) rendered to the 128px `icon.png` with cairosvg.

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

## Trusted app, host API and UI (Phase 3)

- App: `app/webxdc/group-call/` (UI only — no WebRTC/mic code, a unit test
  enforces it) → `app/builtin/group-call.xdc` via
  `node tools/build-builtin-xdc.mjs` (store-only zip, byte-reproducible;
  `tests/group-call-app.test.mjs` fails when stale). Bundled in Tauri via
  `builtin_xdc.rs` (`prepare_builtin_xdc("group-call")`), the PWA ships it
  under `builtin/`.
- **Trust** = SHA-256 of the instance's .xdc bytes ∈ `app/js/trusted-xdc.js`
  (generated by the same tool, append-only so call messages sent by older
  builds keep working; never hand-edit). `xdc-trust.js` hashes with
  WebCrypto; webxdc-manager reads the bytes via `read_media_bytes`
  (Tauri, accounts-dir scoped) or the core file store (PWA) when the app
  opens (`active.trust`). File name / manifest / sender never count —
  `GROUP_CALL_FILE_RE` only picks the card's name and icon.
- Host API (shim `webxdc.veltaCall`: `available/join/leave/setMuted/getState/onState`;
  host methods `veltaCallJoin|Leave|Mute|State`, state pushes
  `velta-call-state`). KEEP: every method checks `activeTrust() ===
  "group-call"`; untrusted apps get `available() === false` and rejects.
- Join from the app → host consent modal (`askGroupCallConsent`: mic +
  TURN/IP note) → `joinGroupCall` (relay-only, refused during a 1:1 call
  or while in another group call).
- In-call bar `#group-call-bar` (group-call-ui.js, main.css): host chrome
  outside the iframe, survives chat switches/app close: "Velta group call ·
  <chat> · N · <who> speaking", Mute, Leave; tapping it opens the chat and
  the app (`velta-open-chat` event → app.js `openChat`).
- Entry: attach menu "Group call" in group chats (not local chats) →
  sends group-call.xdc, opens it; the app shows Join.
- Delta Chat (no `veltaCall`): "This group call needs Velta" + who is in the
  call, read from the `veltaCall` status updates.

Tests: `tests/group-call-app.test.mjs`; `scripts/e2e-group-call-app.mjs
[--shots DIR]` — 3 hosts with the real shim frame + real app UI + real
sessions (one without realtime), joins via the app's button, mute icon
propagation, host bar, a tampered bundle (1 byte off) gets no API, the DC
view shows the roster, leave from the bar.

## Chat card, call name, in-call bar (Pavel's feedback)
- **Card** — `app/js/group-call-card.js`, wired by `chat-view.js`
  `_wireGroupCallCard` for a `group-call*.xdc` message whose bundle passes
  `isGroupCallApp(msgId)` (hash trust; the file name only picks candidates).
  Shows the sender's `<velta-avatar>` (authentic `m.fromContact`, photo or
  initial on profile color), the call name, "Started by X · N in call",
  up to 5 member avatars (+N), and Join / "✓ You're in" + Open + Leave /
  "Call ended" + Start again.
  Ended (KEEP): creator avatar, name, "Call ended · <duration>" (first join
  → last join/leave/hb ts; just "Call ended" if unknown) and Start again
  only — no count, member avatars, Open, You're in or Leave. `cardModel(updates,{live})` derives state from
  the status updates (a `statusOnly` GroupCallSignal, TTL_UPDATE liveness);
  while we're in the call the live roster wins. Refresh: status-update
  events, `onCallChange`, 20 s timer; cached virtual-scroller rows re-run
  `card._gcRefresh` (KEEP: never stop the wiring when off-screen).
- **Call name** — "Group call" asks via `askGroupCallName()` (optional,
  default "Group call", `cleanTitle`: ≤80 chars, no control chars). The
  starter posts a `{vgc:1,t:"meta",title,creatorName}` status update
  (`announceGroupCall`); `callMeta(updates)` = first meta. The app (Velta
  and Delta Chat "needs Velta" view) shows the name + "Started by X".
- **Heartbeat** — every member sends a status-update heartbeat every 90 s
  (not only PWA peers) so cards of non-members see liveness.
- **Bar** — `barVisible(s, screen)`: shown only while in a call AND the call
  screen (`setCallScreen(msgId)` from webxdc-manager on open, `null` on
  close) is not that call. It is a full-width strip that pushes `.app`
  (and the fixed mobile `.main`) down by `--gcb-h` + safe-area — never
  overlaps the chat header.
- **Design tokens** — card, bar and call app use only main.css tokens
  (`--bg-sidebar`, `--bg-hover`, `--bg-active`, `--accent`, `--on-accent`,
  `--text`, `--text-dim`, `--green`, `--danger`, `--border`, `--shadow`,
  `--radius-bubble`, `--vw`) and existing components (`.btn-text`,
  `.btn-text.btn-primary`, `<velta-avatar>`, `showModal`). The trusted app
  gets live token values via `getInfo().veltaTheme` / `veltaCall.getTheme()`;
  its CSS fallbacks are the dark snapshot (Delta Chat only). Linted by
  `tests/group-call-card.test.mjs` (no hex/rgb/hsl in gc/gcb rules).
- **In-bubble colors** — the card lives in a bubble, so its buttons follow
  the in-bubble `.btn-text` rules (AGENTS.md: `--text-meta-out` on the own
  bubble, `--accent-text-in` light incoming, `--accent-2` brutal incoming).
  Join / Start again are NOT `.btn-primary` accent fills (that was blue on
  blue in outgoing bubbles): `.gc-primary` = in-bubble `.btn-text` + a
  `currentColor` ring. Leave is not `--danger` and "You're in" not
  `--green` inside bubbles (both < 4.5:1). `scripts/e2e-group-call-contrast.mjs`
  checks every state, in/out, dark/light/brutal + yellow/red custom accents.
- **Mock demo** — `velta-mock=1`: Weekend Crew has a seeded call
  ("Saturday hike plan" by Mara, 2 members); `velta-demo-end-call` window
  event ends it. e2e: `scripts/e2e-group-call-chat.mjs` (360 px).

## Not done yet / device testing
- Consent "remember for this chat" is not implemented (prompt every join).
- No ringing by design: the chat card is the invite (plus the info line +
  summary for notifications).
- Android: audio route uses `call_audio_start(speaker=true)`; background
  behaviour (screen off, app in background) needs a device run. WebKit
  shells (macOS/Linux) untested.
