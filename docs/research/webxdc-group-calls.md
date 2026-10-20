# Trusted webxdc app for group audio calls — research and design

Status: research/design only, 2026-10-20. No code. Core 2.64. Sources: this
repo (`docs/agents/webxdc.md`, `docs/agents/calls.md`, `app/js/calls.js`,
`app/js/webxdc-manager.js`, `app/webxdc-host/*`, `webxdc_serve.rs`,
`VeltaWebChromeClient.kt`, `docs/research/iroh-layer-research.md` with its
`core/src/peer_channels.rs` citations) and upstream webxdc spec
(webxdc.org/docs, `joinRealtimeChannel`), Delta Chat desktop/Android webxdc
hosts (`webrtc 'block'` CSP, RTCPeerConnection blocking), deltachat/calls-webapp.
Items marked *(verify)* were not measured.

## 0. Short version

- **Recommendation: "host-owned media".** Do NOT give the iframe WebRTC.
  The trusted app is only UI + roster; Velta's host (the same JS that runs
  1:1 calls, `CallManager` generalized to N peers) opens the mic, owns all
  `RTCPeerConnection`s and TURN, and exposes a small `webxdc.veltaCall`
  API (join/leave/mute/state events) to apps whose bundle hash is on a
  built-in allowlist. The sandbox (opaque origin, network-less CSP,
  RTCPeerConnection stub) stays exactly as it is.
- **Signaling:** webxdc realtime channel (iroh gossip) as primary, status
  updates as fallback/announce. Wasm PWA has no realtime yet → status-update
  signaling there.
- **Topology:** full mesh, audio-only, **cap 6 participants** (soft cap 8 on
  desktop). SFU (LiveKit on a relay) is a later optional phase.
- **Audio over iroh gossip:** not recommended (no sender id, broadcast
  fan-out, head-of-line TCP/QUIC relaying, no jitter control); keep as a
  research spike at most.
- **Estimate:** MVP (Phases 0–3) ≈ **14 working days**; with PWA + polish ≈ 19;
  SFU option +8–12.

## 1. How Velta hosts webxdc today

| Shell | Host | Isolation | Network | WebRTC |
|---|---|---|---|---|
| Tauri desktop | `webxdc://`/`webxdc.localhost` custom protocol (`webxdc_serve.rs`), shim injected into index.html | iframe sandbox **without** `allow-same-origin` → opaque origin (KEEP) | per-response `WEBXDC_CSP`: webxdc origins + `data:`/`blob:` only | shim stubs `RTCPeerConnection` (bypassable via nested about:blank — documented ceiling); no `allow="microphone"` on iframe |
| Android (Tauri WebView) | same protocol & shim | same | same CSP | same stub; `VeltaWebChromeClient.onPermissionRequest` delegates to Tauri's client — origin of the request is not checked today for webxdc *(verify: must deny anything from webxdc origin)* |
| Wasm PWA | service worker `webxdc-run/…` loader + `frame.js`, header CSP `sandbox …` → opaque | `frame.js` asserts `origin === "null"` | only blob:/data: | same shim stub |

Shared: postMessage bridge in `webxdc-manager.js`; host answers only the
open app's own frame.

### What "trusted" would mean — two options

**A. Grant WebRTC to the iframe** (what the brief suggests). Needs: CSP
exception per app (`connect-src` is irrelevant for ICE, but the stub must be
skipped), iframe `allow="microphone"`, Android `onPermissionRequest` grant
for that frame, TURN credentials handed to app code. Problems: the opaque
origin means permission prompts are attributed to the *Velta* origin (all
apps look the same to the browser); once WebRTC is on, the app can open
data channels to any host via TURN/STUN = an exfiltration channel; the
granted capability lives in third-party code (even if we wrote it, it's a
blob in a chat).

**B. Host-owned media (recommended).** The iframe never gets WebRTC or the
mic. Host API, injected only for trusted apps:
```
webxdc.veltaCall.join({audio:true}) -> Promise<{selfId}>
webxdc.veltaCall.leave(); .setMuted(bool)
webxdc.veltaCall.onState(cb)  // {participants:[{id,name,muted,speaking,level}], state}
```
Velta prompts ("Join group call in <chat>? Uses your microphone and
turn.delta.chat"), opens the mic with the existing `MIC_CONSTRAINTS`,
runs N `RTCPeerConnection`s with `safeIceServers()`, plays audio in host
`<audio>` elements, and keeps the call alive even if the app frame is
closed (call bar in the chat header). The app is just a renderer; a
malicious app at worst draws a fake UI — it cannot reach the network.

### Trust identification
- Trust = **SHA-256 of the .xdc bytes** ∈ allowlist compiled into Velta
  (from `app/builtin/*.xdc`, built in CI; same pipeline as `prepare_builtin_xdc`).
  The host hashes the blob of the webxdc message (core `get_webxdc_blob`
  /file path) at open time. Name, manifest `source_code_url`, app id are
  attacker-controlled and NEVER used.
- Allowlist holds the current + previous N versions so old messages keep working.
- Optional later: ed25519 signature over the hash (Velta release key) to allow
  updates without a client release. Not needed for MVP.
- Also per-chat consent: first join in a chat shows the prompt; "remember
  for this chat" stored in Velta settings, not in the app.

## 2. Signaling

**Realtime channel (iroh gossip, `peer_channels.rs`):**
- Size ≤ 128 KiB per message — SDP (~3–6 KB) fits.
- Rate: no explicit limit in core; gossip is broadcast to all topic members
  (HyParView/PlumTree), so every signal reaches everyone — encode
  `{to, from, type, sdp|cand}` and filter in the host. Webxdc spec asks
  apps to be modest; ICE trickle should be batched (≤ 10 msgs/s) *(verify
  for drops under bursts)*.
- Reliability: best-effort; no delivery ack, no history — a peer joining
  later sees nothing sent before. Needs app-level retry (offer resend after
  2 s, idempotent by `(from,to,sessionId,seq)`).
- No sender attribution from core (`WebxdcRealtimeData{msgId,data}`): `from`
  is self-declared. Peers derive identity via `webxdc.selfAddr` in a
  status update ("join" announcement) and must treat realtime `from` as
  unauthenticated → bind it by including a nonce from the authenticated
  status update; DTLS fingerprint in SDP is the real per-session key.
- Join: only members who opened the app and called `joinRealtimeChannel`
  receive. Not "all members" automatically. Joining sends a hidden email
  advertisement (latency = email delivery, seconds) — first connect is
  slower; then direct/relay iroh.
- Wasm PWA: realtime not available (`veltaRealtime:false`, Step B of
  beam-pwa-research). iroh in wasm is relay-only (iroh supports wasm
  browser builds with relay transport, no UDP holepunching) — doable later
  but not in 2.64 wasm build.
- **Fallback: status updates** (`sendUpdate`): persistent, authenticated
  sender, goes over email (1–10 s), visible to Delta Chat users as app
  updates; acceptable for join/leave + offer/answer with non-trickle ICE
  (gather ≤ 3 s like 1:1 calls). Clean-up: payloads expire logically by
  `sessionId`; they stay in the chat forever (privacy note: SDP has no IPs
  if TURN-only; with host candidates it would persist IPs in email → in
  fallback mode force `iceTransportPolicy:"relay"`).

Design: status updates for **roster** (join/leave, `sessionId`, nonce);
realtime for **SDP/ICE**; automatic fallback to status updates when
realtime is unavailable or no answer within 5 s.

## 3. Topology

Mesh: each peer sends N−1 and receives N−1 streams. Opus 32 kbps + RTP/
SRTP/UDP/IP overhead ≈ 45–50 kbps per stream (via TURN, TCP worse).

| N | up per peer | down per peer | encoders* |
|---|---|---|---|
| 4 | 150 kbps | 150 kbps | 3 |
| 6 | 250 kbps | 250 kbps | 5 |
| 8 | 350 kbps | 350 kbps | 7 |
| 10 | 450 kbps | 450 kbps | 9 |

*Chromium/WebView encodes per peer connection. Bandwidth is fine on 4G even
at 10; the limits are mobile CPU/battery, the 2-peer-per-pair ICE setup
(N(N−1)/2 connections, 28 at N=8), and TURN load on turn.delta.chat (all
relayed). Practical: **6 on mobile, 8 desktop**. Can lower to Opus 24 kbps
+ DTX to stretch.

SFU: LiveKit (Go, single binary, has TURN built in) or mediasoup (Node).
Small VPS (2 vCPU, €5–10/mo, Hetzner) handles ~50–100 audio participants;
bandwidth is the cost. Needs a server, auth tokens (who may join a room —
would need a signed room token derived from chat membership), and makes a
central party see metadata (not content if E2EE insertable streams are
added — extra work). **Recommend mesh now; SFU only if users need >6.**

## 4. Audio over iroh realtime itself

Bandwidth: 32 kbps Opus = 20 ms frames of ~80 B; gossip broadcasts each
frame to all → per sender ~50 msgs/s; with N=6 every node handles 250
msgs/s plus gossip forwarding overhead (eager push to neighbors, IHAVE).
Latency: QUIC streams over the iroh relay (TCP/WebSocket when not
holepunched) → head-of-line blocking, 100–300 ms spikes; no jitter buffer,
no FEC/PLC unless re-implemented with WebCodecs `AudioEncoder`+AudioWorklet.
No sender id (must self-declare). Plus gossip traffic is per-app data
volume against relay limits. Feasible as a toy for 2–3 people on good
networks; not a product path. Skip.

## 5. UX

- Start: chat menu / call button in group chats → "Start group call"
  sends the bundled `group-call.xdc` to the chat (one instance = one
  call room; reused while active) and joins.
- In-chat message card: "Group call · 3 in call · Join". Join → consent
  prompt (first time per chat) → mic → in-call bar in the chat header
  (participants avatars, mute, leave) that survives navigation; app frame
  shows grid with speaking ring (active speaker from host `getStats`
  `audioLevel` / AnalyserNode, 200 ms smoothing), mute icons (via
  mutedState-like data channel), connection quality.
- Leave: button, app close does not leave (host owns call); last leaver
  posts "call ended · 12 min" status update with `info` (shows a system-ish
  line in chat for DC too).
- Android: foreground service + `CallAudio.kt` route (earpiece/speaker/BT)
  reused; incoming "call started" notification via the status-update
  `notify` field for chat members.
- Delta Chat: the .xdc opens normally there; `webxdc.veltaCall` undefined →
  app shows "This group call needs Velta" + link, plus the roster (from
  status updates) so DC users see who is in the call. Summary text via
  `summary` field ("3 in call").

## 6. Security / privacy

- **IP exposure:** mesh direct ICE reveals each member's IPs to all other
  members (group members may be strangers). Default **TURN-only**
  (`iceTransportPolicy:"relay"`) for groups, with a setting "allow direct
  connections" for lower latency. Costs turn.delta.chat bandwidth — ask
  chatmail operators / check fair-use *(open)*.
- TURN creds come from core `ice_servers()` and stay in the host (option B).
- **Permission prompts:** Velta prompt per chat + OS mic permission; Android
  `onPermissionRequest` must deny every request from webxdc origins (fix
  regardless); host mic indicator always visible while in call.
- **Spoofing trust:** only the content hash counts; a lookalike app with
  the same name/icon gets no API (shows "needs Velta" or nothing). A
  malicious *trusted-looking UI* can't do harm in option B. Display the
  "Velta verified" badge in host chrome (outside iframe), never inside.
- **Spoofed signaling:** realtime `from` unauthenticated → a member of the
  realtime topic could inject offers; mitigate by binding to status-update
  nonce and showing participant names from authenticated roster only.
  Topic members are already chat members (topic is in the encrypted .xdc mail).
- Media E2E: DTLS-SRTP peer-to-peer; TURN sees only ciphertext.
- The existing iframe-WebRTC stub ceiling (nested about:blank) is unchanged
  by this design; consider adding `webrtc 'block'`-equivalent once
  Chromium supports it.

## 7. Plan

| Phase | Work | Days |
|---|---|---|
| 0 | Android `onPermissionRequest` deny for webxdc origins; hash allowlist + `veltaCall` injection plumbing (Tauri + PWA), unit tests | 2 |
| 1 | Generalize `CallManager` → `GroupCall` (N peer connections, TURN-only default, mute data channel, audio levels), headless 3-peer e2e in Chromium (extend `e2e-call-audio.mjs`) | 5 |
| 2 | Signaling: roster over status updates, SDP/ICE over realtime, retry/idempotency, fallback to status updates | 3 |
| 3 | `group-call.xdc` app (UI, DC "needs Velta" notice), chat entry point, in-call header bar, Android audio route/foreground service | 4 |
| 4 | PWA (status-update signaling only), polish, a11y, docs/KEEP rules | 3 |
| 5 | Field test on real networks/mobile (CPU, N=6), tune bitrate/DTX | 2 |
| opt | SFU (LiveKit on a relay, room tokens, deploy) | 8–12 |

MVP 0–3 ≈ 14 days; full 0–5 ≈ 19 days.

Risks: realtime gossip loss/latency under bursts (unmeasured); hidden-mail
advertisement delay on first join; TURN capacity/fair-use on
turn.delta.chat for N×N relayed streams; mobile CPU with 5 encoders;
Android WebView background audio being killed; status-update fallback
leaves permanent rows in chat; core realtime API changes (iroh 1.0
migration); DC interop limited to a notice.

## Open decisions for Pavel
1. Option B (host-owned media) vs A (WebRTC inside the trusted iframe).
2. Participant cap (6 proposed) and whether an SFU is ever wanted (who runs it).
3. TURN-only by default for groups (privacy) vs direct (latency, less TURN load).
4. Trust model: bundled hash allowlist only, or also signed updates.
5. PWA in MVP or after realtime lands in wasm.
6. Whether signaling via status updates (visible/persistent in chat history) is acceptable as fallback.
