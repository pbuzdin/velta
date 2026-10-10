# iroh second layer — design and phased plan

Status: proposal, 2026-10-06. Docs only, no code yet. Evidence and citations:
[`research/iroh-layer-research.md`](research/iroh-layer-research.md). Related:
[`agents/p2p.md`](agents/p2p.md) (Local chat engine),
[`../PLAN-PWA-WEBSOCKET.MD`](../PLAN-PWA-WEBSOCKET.MD) (PWA, Architecture C).

Pavel's requirement: "iroh chat and calls will have separate chat folders and
these chats will be marked with an 'iroh' chip near their avatars". iroh is a
**second layer**. It never replaces email/chatmail transport.

---

## 0. Short version

- **What core actually exposes:** iroh only through webxdc realtime (gossip
  per webxdc message, ephemeral node keys, no sender attribution, 128 KiB
  messages, one hidden email per join) and backup transfer. There is no API for
  chat messages, presence or calls over iroh (research §1, §2).
- **Recommended architecture (B):** **core stays the system of record and the
  authenticated rendezvous. Velta's existing iroh engine in the Tauri shell
  (`p2p.rs`, same iroh 0.35 crate) becomes the live data plane.** The engine
  gains a relay mode (the chatmail relay's iroh relay) and "links": iroh nodes
  bound to core contacts. Every user-visible message still goes through
  `send_msg` first. The iroh copy is a provisional fast path, de-duplicated by
  Message-ID (`rfc724_mid`). **No change to production `core/`.**
- **MVP (Phases 0+1, ~16 days):** 1:1 chats only, desktop and Android:
  - per-chat opt-in link with consent;
  - presence, typing and instant text with email dedup;
  - live "delivered/read" hints;
  - the **iroh folder** and the **"iroh" chip**.
- **Later:**
  - Phase 2: calls signalling over iroh (WebRTC media stays);
  - Phase 3: large direct files;
  - Phase 4: groups;
  - Phase 5: the iroh 1.0 migration;
  - Phase 6: the PWA, relay-only.
- **Total:** ~41 working days for Phases 0–5, +4 days for a PWA spike, and +15–25
  days for a full PWA layer.

---

## 1. Goals, non-goals, invariants

**Goals:**
- Lower latency between online Velta peers.
- Live state (typing, presence, delivered/read hints).
- Faster call setup.
- Later: files bigger than email allows.
- Clear UX: an iroh folder and an "iroh" chip.

**Non-goals:**
- Replacing chatmail.
- iroh-only chats with addresses. Local chat (`p2p:`) already covers serverless
  chat and stays as it is.
- Media over iroh in this plan (research §3.4).
- Patching production `core/`.

**Invariants (become KEEP rules in AGENTS.md when built):**

1. **Email first.** Every user-visible message, call and file stub is created
   through core (`send_msg`, `place_outgoing_call` …) before or alongside its
   iroh copy. Nothing visible exists only on iroh. The one exception is Phase-3
   large files: an explicit, consented transfer whose email stub always exists.
2. **Default off.** A fresh install opens no sockets for this layer. This is
   the same rule as Local chat (AGENTS.md §5.4).
3. **Degrade to plain chatmail.** A peer without Velta or without the layer,
   a peer that is offline, or any iroh failure: the chat behaves exactly like
   today. No errors and no lost messages.
4. **The core copy wins.** When the email copy arrives it replaces the
   provisional iroh copy: content, order and state. Core MDNs remain
   authoritative for read state.
5. **Never use n0 default relays.** Only the profile's chatmail iroh relay,
   or none. Research §4: n0's 0.35 relays end on 2026-12-31, and upstream
   avoids n0 (#5591, #8490).
6. **Respect the proxy.** If core has a proxy enabled, the layer stays off,
   because iroh bypasses proxies (`core/src/net/proxy.rs:158-159`).

---

## 2. What an "iroh chat" is

An **iroh chat** is a **normal core 1:1 chat** (Phase 4 adds groups) whose
contact has at least one **linked Velta device**. A linked device is an iroh
node id bound to that contact through the link protocol (§4.1), with the layer
enabled on both sides. Its history and storage are the core chat's; the iroh
layer adds live delivery and state on top.

States (the chip and the header show them as text):

| State | Meaning | Chip | Header status |
|---|---|---|---|
| `none` | no link | — | as today |
| `pending` | offer sent or received, not accepted | — (chat menu shows "iroh invite pending") | — |
| `linked` | link accepted, peer not reachable now | "iroh" (outlined) | "iroh · offline, using email" |
| `live-direct` | session up, direct path | "iroh" (filled + dot) | "online · iroh direct" |
| `live-relay` | session up via relay | "iroh" (filled + dot) | "online · iroh via relay" |
| `blocked` | layer off, proxy on, or version mismatch | "iroh" (struck/dimmed + reason in menu) | "iroh unavailable: <reason>" |

**Opt-in is per chat** and needs consent on both sides, because direct
connections expose IP addresses (research §2.2). It becomes automatic only if
Pavel decides so (D2).

---

## 3. Architecture decision

Options (research §6): **A** JS-only on core gossip, **B** Velta engine as the
data plane with core as rendezvous, **C** a core patch series.

**Recommendation: B.** Reasons:

1. **Velta already owns a tested iroh engine** with almost every primitive
   needed: persistent identity, authenticated 1:1 QUIC sessions, `Msg`/`Ack`/
   `Typing` frames, offline queue, chunked files, ALPN versioning, unknown-frame
   tolerance and Rust tests (`docs/agents/p2p.md`). Core's realtime channel
   offers broadcast only, without sender identity or backpressure.
2. **No core patches.** Desktop runs the stock `deltachat-rpc-server`
   sidecar, so any core change means a custom sidecar build on every platform,
   on top of the production core quilt (21 ops at 2.63.0) and the wasm series.
3. **Identity is stable.** Core's iroh node id changes on every `stop_io`.
   Rendezvous via core would cost one hidden email per chat per restart.
4. **It fits Pavel's "use the iroh inside core" in practice.** It is the same
   iroh 0.35 library, already compiled into Velta's binary (one crate build on
   Android). Only the endpoint is Velta's.

**What B costs:**
- **Rendezvous:** needs an encrypted, contact-authenticated channel. Phase 1
  uses a **helper webxdc status-update channel** (one app card per iroh chat in
  other clients, §4.1) or in-person **QR linking** (no artefact).
- **Relay URL:** JSON-RPC does not expose the relay URL. The engine derives it
  from the transport domain, verified in Spike S1.
- **Two endpoints per device:** core's (only when webxdc realtime is used) and
  Velta's.
- **PWA:** needs a later wasm port (§8).

**Where code lives:**

| Piece | Location |
|---|---|
| Link engine | `velta-app/src-tauri/src/p2p/link.rs`. A new module beside `groups.rs` with its own endpoint per core profile (relay mode, per-profile identity). Local chat's LAN endpoint stays untouched. ALPN `/velta/link/1`. Commands `link_*`, events `link-event`. |
| Frontend | `app/js/iroh-layer.js`: registry mirror, consent UI, chat decoration (`chat.iroh`), provisional message injection and reconciliation, live ticks. Hooks into rpc-core, like `local-chat.js` but **decorating core chats instead of minting new chat ids**. |
| Helper webxdc | `app/xdc/velta-link/` (static `index.html` explaining the layer, `manifest.toml`), zipped by a small `scripts/build-link-xdc.mjs` into a committed `.xdc` (the frontend has no build step). |
| Calls glue | `app/js/calls.js` gets an injected `fastSignal` transport (Phase 2). |
| Core | **unchanged.** Option C, if ever wanted, goes into an apply-on-copy series `docs/research/iroh-patches/` (same pattern as `docs/research/wasm-patches/`, applied only to a copy via a tool) and as an upstream proposal, never into production `core/`. |

Option A stays useful in one place: a **PWA spike**, if the wasm core's peer
channels work in a browser (§8).

---

## 4. Protocol sketch

### 4.1 Link: capability negotiation and identity binding (via core)

**Carrier (Phase 1, default): the helper webxdc "Velta iroh link".**

1. User A turns on "iroh layer" for the chat with B. Velta sends
   `velta-link.xdc` to the chat once (`send_msg`, viewtype Webxdc).
2. A then sends a **status update** (`send_webxdc_status_update`) with the
   payload below. There is no `info` field, so other clients show no extra rows.
   `uid` is set for dedup.
3. B's Velta sees the xdc and the update, and asks B for consent:

   > "Anna wants to turn on iroh live mode in this chat. Messages still go by
   > email too. Direct connections show your IP address to Anna."

   On Accept, B sends its own `accept` update.

Payload:

```json
{ "velta": "iroh-link", "v": 1, "op": "offer|accept|update|revoke",
  "addr": "<sender selfAddr>", "device": "<random device id>",
  "node": "<iroh NodeId>", "relay": "https://<relay>/",
  "iroh": "0.35", "alpn": ["/velta/link/1"],
  "caps": ["text", "typing", "presence", "read", "call-sig"],
  "token": "<16 random bytes, b64>", "direct": true, "ts": 1791234567 }
```

**Why the binding holds (1:1):**
- Core accepts status updates only from SELF or chat members
  (`core/src/webxdc.rs:692-700`), and they travel OpenPGP-encrypted inside the
  chat.
- In a 1:1 chat, an update with `addr != selfAddr` therefore comes from the
  contact. Only my own devices could forge it, and they are trusted.
- The node id is bound by the same guarantee: an attacker would need the
  contact's OpenPGP key or one of my devices.

**Other details:**
- **Revocation:** an `op:"revoke"` update. Deleting the xdc also kills the
  link, because core deletes the updates with the instance.
- **In Velta:** the xdc bubble is hidden, identified by manifest name and
  marker via `get_webxdc_info`, and replaced by an info row "iroh layer on".
- **In DC clients:** a single app card. Opening it says "This chat uses Velta's
  iroh layer. Nothing to do here; messages arrive normally."

**Alternative carrier: QR link (no artefact).** Reuse the Local chat ticket
flow. A `VELTALINK1:` ticket carries node id, relay, token, `selfAddr` and the
profile's key fingerprint. The scanner confirms the contact by address, and the
fingerprint is checked against `get_contact_encryption_info`. Good for
in-person setup and for users who object to the app card.

**Later carrier (option C):** an invisible `Velta-Iroh-Link` header via a core
patch or upstream API. Only if upstream accepts something similar.

### 4.2 Session setup

- Endpoint per core profile: `RelayMode::Custom(<profile relay>)`, persistent
  per-profile secret key in
  `<AppLocalData>/p2p/link/<profile-uuid>/identity.key`. The node id must
  differ per profile, so that profiles are not correlated.
- **Dial policy:**
  - when a linked chat is opened;
  - on app foreground, for the N most recent linked chats (N=10);
  - on an incoming connection from a linked node.
  - Exponential backoff. The endpoint closes 60 s after the app goes to the
    background unless a call is active (§4.10).
- **Auth:**
  - The QUIC handshake pins the remote node id.
  - The acceptor rejects node ids that are not in the registry for that
    profile.
  - The first frame is `hello { v, token_mac }`. `token_mac` is an HMAC of the
    session nonce with the link token, which proves that this link (chat and
    profile) is meant and not only the node.
  - Unknown frame types are skipped (`#[serde(other)]`).

### 4.3 Envelopes (`/velta/link/1`, newline-delimited JSON like p2p.rs)

| Frame | Fields | Phase |
|---|---|---|
| `hello` | `v`, `token_mac`, `caps` | 1 |
| `live` | `mid` (rfc724_mid of the core copy), `ts`, `text`, `quote_mid?` | 1 |
| `live-ack` | `mid` | 1 |
| `live-read` | `mids[]` | 1 |
| `typing` | `on` | 1 |
| `presence` | `state: active, away` | 1 |
| `call-ring` / `call-answer` / `call-ice` / `call-end` / `call-busy` | `call_mid`, `sdp`/`cand`, `video`, `reason` | 2 |
| `file-offer` / `file-chunk` / `file-end` / `file-accept` | `id`, `name`, `size`, `mime`, `sha256`, `stub_mid` | 3 |
| `group-live` | `mid`, `chat_key`, `text`, … | 4 |

Size: text frames ≤ 64 KiB. Longer texts go by email only.

### 4.4 Dedup and reconciliation (the core of the MVP)

**Sender:**
1. `send_msg` → `msg_id`.
2. `get_message_info_object(msg_id).rfc724Mid`. The id is assigned at prepare
   time, before SMTP.
3. Send `live { mid, … }` to every online linked device of the contact.
4. Add the core `msg_id` to the `mid` → `msg_id` map.

**Receiver:**
1. On `live`: if `mid` is already mapped to a core message, ignore the frame.
   Otherwise insert a **provisional bubble** with a numeric id `3e9+seq`,
   following the numeric-id rule of `local-chat.js`. It is flagged `live: true`,
   has a small "via iroh" marker, is persisted in the engine log
   (`link/<profile>/live-<contact>.jsonl`) and is notified once.
2. Send `live-ack`.
3. On core `IncomingMsg` in a linked chat:
   - fetch the message's `rfc724Mid` (one extra RPC, only in linked chats);
   - if a provisional bubble with that `mid` exists, **swap it in place** for
     the core message;
   - carry over the read-pending flag: if the user saw the provisional copy,
     call `markseen_msgs` now, which sends the core MDN;
   - **suppress the second notification**.
4. If no email copy has arrived after 15 minutes, the bubble shows "not yet
   received by email". The provisional row stays visible and is dropped once
   reconciled. Rows still unreconciled after 30 days are dropped (decision D10).

**Notification dedup on Android:**
- The Rust background poller (`bg_events.rs`) shares a "notified mids" set with
  the link engine (same process).
- For linked chats only, it resolves the `rfc724_mid` before posting.
- In the MVP the endpoint is closed in the background anyway. The set covers
  the race at the moment the app goes to the background.

### 4.5 Ordering

- Provisional bubbles are placed in arrival order, timestamped with the
  sender's `ts` clamped to `[now-5min, now]`.
- On reconciliation the core message takes the slot, and a full reload uses
  core's sort order. Rare jumps are acceptable. They are pinned by tests so that
  they never duplicate.

### 4.6 Acks, read state, typing, presence

- **Ticks:**
  - `live-ack` gives a "delivered via iroh" tick variant: the existing single
    tick plus a small "iroh" glyph, with text "Delivered (iroh)".
  - `live-read` gives a provisional double tick, used only when `mdns_enabled`
    is on.
  - The core MDN still arrives and is authoritative.
- **Typing:** `typing.js` already exists. `TypingSender` is reused; the setting
  is shared with Local chat (`velta-p2p-typing`) or split (D8).
- **Presence:** session up and `presence:active` → "online · iroh". Never sent
  when "Share presence" is off. Then only the chip state reveals reachability.

### 4.7 Fallback rules

| Situation | Behaviour |
|---|---|
| Peer offline, not linked, or layer off | email only, no UI noise |
| `live` send fails or times out | ignore; email is already queued |
| Core `send_msg` fails | no `live` is sent (email first) |
| Version mismatch (`iroh` 0.35 vs 1) | state `blocked`: "iroh (peer needs update)"; email only |
| Relay unreachable and no direct path | `linked` (offline); email only |
| Proxy enabled in core | layer forced off with an explanation |

### 4.8 Multi-device

- Each Velta device links separately (its own `device` and `node`). One
  contact can have several linked devices, and `live` goes to all that are
  online.
- My other devices receive my sent messages through core's normal
  self-delivery. No own-device iroh mirroring in Phase 1.
- Read state syncs across my devices through core as today.
- My own devices see my `offer`/`accept` updates through self-delivery, so the
  registry knows "this chat is linked from device X". Each device must still
  accept consent locally before it opens sockets (D2).

### 4.9 Groups (Phase 4)

- JSON-RPC does not expose a group id (`grpid`). Membership comes from the
  core chat's contact list.
- **Binding comes from each member's 1:1 link**, not from group-level updates,
  because group status updates cannot be attributed to a member (research §2.3).
- Group live messages go as `group-live` directly to each linked, online member
  (mesh; cap 8 members for live, larger groups use email only), with the same
  `mid` dedup.
- Gossip is not needed at these sizes. Revisit after the iroh 1.0 migration.

### 4.10 Privacy, relay modes, battery

**Privacy:**
- Direct connections reveal IPs to the linked peer, and the relay sees node ids
  and IPs.
- Settings:
  - "Only through relay (hide my IP)": `direct:false` in the link. Whether iroh
    0.35 can suppress direct-address exchange is checked in Spike S3. If it
    cannot, the option arrives with iroh 1.0.
  - "Share presence".
  - "Share typing".
- The consent text names the IP exposure.

**Relay:** the profile's own chatmail iroh relay. Each side dials the peer's
relay from the link payload. No n0 fallback.

**Android battery:**
- The endpoint runs only while the activity is in the foreground, plus 60 s,
  or during a call.
- No keepalive in the background or in Doze. Email and push deliver as today.
- Reconnect on `velta-foreground`.
- Measured in Spike S4. Upstream #7058 notes that idle endpoints keep pinging
  the relay.

### 4.11 Versioning and iroh 1.0

- **`/velta/link/1` on iroh 0.35.**
  - The 0.35 wire is incompatible with 1.0 (core PR #8182, relay#1010).
  - Chatmail relays run 0.35 relays today.
  - n0 0.35 relays end 2026-12-31. They are not used anyway.
- **Phase 5:**
  - Move the link engine to iroh 1.0 and `/velta/link/2`, once chatmail relays
    publish 1.0 relays (new METADATA key per relay#1010).
  - During the transition, link payloads advertise `iroh`; mismatches show
    "peer needs update".
  - Option: link both crates side by side (renamed dependency), as core
    considers for backup transfer. That costs binary size (unverified, estimated
    several MB).

---

## 5. UX

### 5.1 Chat-list folder "iroh"

- **Placement:** a chip `<button type="button" data-cat="iroh">iroh</button>`
  in `#chat-categories` (`app/index.html:46-52`), right after **People**.
- **Visibility:**
  - shown only while the layer is enabled;
  - hideable like other categories (`velta-cats-hidden`, `app.js:62-66`);
  - part of the swipe order (`swipeCategoryStep`).
- **Filtering:** `visibleChats()` (`app.js:1516-1524`) gets an
  `iroh` branch: `state.chats.filter(c => c.iroh && c.iroh.state !== "none")`.
  It is not routed through `chatCategoryOf`, because iroh is an **overlay**
  category.
- **Default semantics: overlay** (recommended, D1). An iroh chat still appears
  in **All** and **People**. The iroh folder is a filtered view. "Exclusive"
  (hide from All) is possible but confusing, because it is the same core chat.
- **Local chat:** `p2p:`/`p2pg:` chats are iroh-only by nature. Recommended:
  include them in the iroh folder too, keeping their wifi badge (D7).
- **Empty state:** "No iroh chats yet. Open a chat with a Velta contact and
  choose 'Turn on iroh'."
- **a11y:** the bar keeps WC plan 2.7 (`aria-pressed`). The chip label is the
  word "iroh".

### 5.2 Calls folder "iroh"

- The Calls side view (`renderCallsView`, `app.js:1365-1384`) gets the
  tablist used by the QR and search screens (`side-tabs`, `app.js:2948-2950`):
  **All | iroh**.
- `recordCallEnded` (`app.js:1243-1250`) stores `via: "iroh" | "email"`,
  meaning whether the signalling took the iroh path. Rows show the same chip.

### 5.3 The "iroh" chip near the avatar

Markup inside `<velta-chat-item>` (`components.js:346-359`). The avatar is
wrapped so the chip can sit on its corner:

```html
<span class="ci-av">
  <velta-avatar …></velta-avatar>
  <span class="iroh-chip" data-state="live" aria-hidden="true">iroh</span>
</span>
<div class="ci-name">Anna <span class="visually-hidden">, iroh chat, connected</span> …</div>
```

- **Text, not colour:**
  - The chip is the literal word "iroh". State is shown by shape: outlined =
    linked, filled plus a "•" glyph = live, strike-through = blocked.
  - The accessible name gets ", iroh chat" plus the state ("connected",
    "offline", "unavailable"). This goes into hidden text today and into the
    row button's composed `aria-label` once WC plan 2.1 lands. The visual chip
    is `aria-hidden` to avoid a double announcement.
- **RTL:**
  - Position with logical properties: `.ci-av { position: relative }` and
    `.iroh-chip { position: absolute; inset-block-end: -2px; inset-inline-end: -4px }`.
  - The Latin word is isolated: `unicode-bidi: isolate; direction: ltr`.
- **High contrast and forced colours:**
  - Chip text and background ≥ 4.5:1 in every theme.
  - `@media (forced-colors: active) { .iroh-chip { border: 1px solid CanvasText; color: CanvasText; background: Canvas } .iroh-chip[data-state=live] { background: Highlight; color: HighlightText } }`.
  - `prefers-contrast: more` → thicker border. Fits a11y plan N4/P3.
- **Sizing:** rem-based, so it scales with the UI-scale setting. It never
  covers the fingerprint glyph's centre. It shows at 48 px row avatars and
  in the chat header (`<velta-chat-head>`).
- **Header status line** (`components.js:373-394`): adds "· iroh direct" /
  "· iroh via relay" / "· iroh offline, using email".

### 5.4 Flows and settings

- **Chat menu:** the "iroh…" entry opens a dialog (native `<dialog>` per
  `docs/modals-audit-and-plan.md`). It has: Turn on/off, Link by QR, Connection
  info (path, relay host, peer device short ids), Unlink.
- **Drawer → "iroh layer":**
  - master toggle (off by default);
  - "Only through relay (hide my IP)";
  - "Share presence";
  - "Share typing";
  - "Show iroh folder".
- **Incoming offer:** a consent dialog with the exact privacy text. Declining
  sends nothing; the offer simply expires.
- **Bubbles:** provisional bubbles show "via iroh" in small text, with a
  `title` and an accessible name. Reconciled bubbles look normal.

---

## 6. Calls over iroh (Phase 2)

**Scope:** signalling acceleration only. Media stays WebRTC with the existing
TURN servers (`core.iceServers()`), in `calls.js`.

| Step | Email path (today) | iroh-accelerated path |
|---|---|---|
| Caller starts | `place_outgoing_call(chat, sdp, video)` → `call_msg` | same, then `call-ring { call_mid, sdp, video }` to linked online devices |
| Callee rings | on `IncomingCall` (after SMTP→IMAP) | immediately on `call-ring`, after checking `who_can_call_me` via `get_config` |
| Callee accepts | `accept_incoming_call(call_id, answer)` | build the answer from the ring SDP, send `call-answer` now; queue `accept_incoming_call` until core has the call message, and ignore the later `IncomingCall` ring for that `mid` |
| Caller connects | on `OutgoingCallAccepted` | apply the `call-answer` now; ignore the later core event |
| Trickle ICE | none (non-trickle, `calls.js:6`) | optional `call-ice` frames after the answer (faster on bad NATs) |
| End | `end_call` | `end_call` **and** `call-end` |

**Reconciliation rules:**
- **Timers:** core's 120 s timers (`calls.rs:38`, `:317-348`) can mark a call
  canceled or missed while it is live over iroh. If a live session exists and no
  `call-end` arrived, Velta must not tear down media on a core `CallEnded`.
- **Call log:** the log stores the iroh truth.
- **Other devices:** `IncomingCallAccepted` from another device of mine stops
  my iroh ringing as today.
- **Busy:** a ring during another call → `call-busy` (cf. upstream #8000).

**Not in scope:** media over iroh. Research §3.4 has the reasons, and upstream
does not plan it. A later spike, Phase R2, may look at desktop-only native
audio over QUIC datagrams.

---

## 7. Large files (Phase 3)

The most-requested upstream use (forum, adbenitez 2026-06-15).

1. The sender picks a file above the email limit (or opts in for any size).
2. Velta sends an **email stub** via core: a text message such as "📎 video.mp4
   (180 MB), sent via iroh to Velta", plus `file-offer { stub_mid, sha256, … }`.
3. The receiver accepts (auto-accept up to N MB from linked contacts, D11).
4. The transfer reuses the p2p chunking (96 KB frames, partial files, sanitized
   names, `is_safe_transfer_id`). The data lands in a Velta-owned blob directory
   under the accounts dir. Velta does not create core messages for the file:
   the stub is the core copy, and the file is attached in Velta's view of that
   stub.
5. Restart and resume: from byte 0 (as today), or ranged resume as a
   stretch goal.

---

## 8. PWA (Phase 6)

- Browsers have no UDP. iroh in wasm is relay-only over WebSocket and
  end-to-end encrypted (research §5).
- **Option P1:** the wasm core's own peer channels (option A, gossip).
  Unverified: the wasm series keeps iroh but never runs it.
- **Option P2 (recommended): port the link engine (protocol subset:
  text, typing, presence, call signalling) to wasm on iroh 1.0**, after Phase
  5. Interop with native peers goes through the shared relay. Calls in the PWA
  use browser WebRTC plus TURN, which already works.
- **Gate:** PLAN-PWA Architecture C landing first
  (`docs/research/wasm-core-landing-checklist.md`).

---

## 9. Phases, estimates, acceptance criteria

Estimates in working days for one developer familiar with p2p.rs.

| Phase | Content | Days |
|---|---|---|
| **0. Spikes** | S1 chatmail iroh-relay URL derivation plus relay mode in a test endpoint (desktop ↔ Android on different networks: connect rate, direct upgrade rate, RTT). S2 helper xdc round trip; rendering in DC Desktop and DC Android; status updates without `info` stay silent; deleting the xdc. S3 relay-only / IP-hiding feasibility on iroh 0.35. S4 latency baseline (email vs iroh) and Android battery for 1 h in the foreground | **3** |
| **1. MVP: 1:1 live layer** | 1.1 per-profile endpoint, relay mode, settings, proxy gate (1.5). 1.2 link protocol (xdc + QR), registry, consent, revoke (2.5). 1.3 session auth, dial policy, presence (1.5). 1.4 `live` envelope, rfc724_mid dedup and reconcile, notification dedup incl. Android poller (3). 1.5 typing, live ack/read hints (1). 1.6 UI: iroh folder, avatar chip, header status, a11y/RTL/forced colours (1.5). 1.7 tests and two-device matrix (2) | **13** |
| **2. Calls signalling** | ring/answer/ice/end/busy frames, `calls.js` `fastSignal`, reconciliation rules, iroh filter in Calls, tests | **6** |
| **3. Large files** | stub plus offer/accept, transfer reuse, consent and auto-accept policy, UI progress/retry | **5** |
| **4. Groups** | membership from core plus 1:1 links, `group-live` mesh, dedup, typing in groups, cap 8 | **9** |
| **5. iroh 1.0 migration** | engine on iroh 1.0, `/velta/link/2`, relay discovery for 1.0 relays, mismatch UX, optional dual stack | **5** |
| Subtotal 0–5 | | **41** |
| **6. PWA** | spike (wasm engine subset over relay, 4 d); full layer after PWA C lands (15–25 d) | 4 + 15–25 |
| R1 (optional) | core patch series spike (invisible header; MIME-over-iroh dedup via `receive_imf`), apply-on-copy only, plus an upstream write-up | 10 |
| R2 (optional) | desktop native audio over iroh datagrams, feasibility only | 5 |

**MVP acceptance criteria (Phases 0+1):**

1. With the layer off (default): no new sockets, identical behaviour. Pinned by
   a test, as for Local chat.
2. Two Velta devices (desktop + Android) on different networks, chat linked:
   - text shows on the peer in **< 1 s p50** while both are in the foreground
     (via iroh, direct or relay);
   - the email copy later replaces the provisional bubble with **0
     duplicates in a 200-message soak**;
   - **no double notification** in the foreground or on Android.
3. Peer offline or unlinked: email-only, no errors, no provisional bubbles.
4. DC Desktop and DC Android peers see every message normally. The helper xdc
   card opens to its explanation page. Nothing else is visible.
5. Typing shows within 500 ms. It is never sent with typing or presence sharing
   off, or to unlinked peers.
6. The chip is visible text "iroh". The row's accessible name contains "iroh
   chat" plus the state. It mirrors correctly in RTL and stays visible under
   forced colours. axe shows no new violations on the chat list.
7. No n0 relay is contacted (asserted in tests by relay config). With a proxy
   enabled in core, the layer refuses to start.
8. Revoke on either side drops the session within 5 s and removes the chip.

**Tests:**
- **Rust (`cargo test --lib p2p::link`):**
  - link registry: add, revoke, per-profile isolation;
  - `hello` HMAC accept/reject;
  - unlinked node rejected;
  - unknown frame skipped;
  - `live` log append/reconcile;
  - relay-mode config never `Default`;
  - two real engines over a local relay (`iroh-relay` test server, if the 0.35
    API allows; otherwise direct loopback).
- **Node (`tests/iroh-layer-*.test.mjs`):**
  - reconcile swap in place;
  - read-pending carried to `markseen_msgs`;
  - notification suppression;
  - numeric provisional ids;
  - the overlay iroh folder filter;
  - chip a11y text;
  - Calls `via` filter.
- **Source guard:** no `link_set_enabled(true)` at boot unless opted in.
- **Manual matrix:** {desktop, Android} × {same LAN, different networks,
  relay-only} × {Velta peer, DC peer}.

---

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | iroh 0.35 end of life; the 1.0 wire break splits peers (research §4) | version field in links, Phase 5, mismatch UX; never rely on n0 |
| R2 | Relay URL not exposed by JSON-RPC; some chatmail iroh relays are broken (#8490) | S1 derivation plus `/generate_204` probe; fall back to "linked (offline)"; propose an upstream `get_info` field |
| R3 | Helper xdc confuses other-client users, or users delete it | clear page in the xdc; QR carrier as an alternative; option C/upstream later |
| R4 | Dedup gaps: email copy never arrives, or the `rfc724Mid` lookup costs an RPC per message | lookup only in linked chats; "not yet received by email" marker; soak test |
| R5 | Double notifications (page plus Rust poller) | shared notified-mid set in Rust; tests |
| R6 | IP exposure; relay-only may be impossible on 0.35 | consent text, settings, S3; ship relay-only with 1.0 if needed |
| R7 | Android battery and Doze | foreground-only endpoint; S4 measurement |
| R8 | Call state divergence against core's 120 s timers | reconciliation rules (§6); tests with simulated email delay |
| R9 | Identity key at rest is unencrypted (same as Local chat); groups lack attribution | document; groups bind via 1:1 links |
| R10 | Engine growth (p2p.rs is ~7k lines); two endpoints per device | separate `p2p/link.rs`; lazy endpoint; shared helpers |
| R11 | Upstream later ships an overlapping feature (e.g. iroh files) with another protocol | small protocol; track #8182 and the forum; be ready to adopt upstream |
| R12 | Desktop sidecar and Android in-process paths differ for the notification hook | hook lives in the shell's poller; desktop page path in JS |

---

## 11. Decisions needed from Pavel

1. **D1 Folder semantics:** overlay (iroh chats also in All/People;
   recommended) or exclusive (only in the iroh folder)?
2. **D2 Opt-in model:** per-chat with consent on both sides (recommended), or
   automatic once both sides have the layer on? Must each of my devices consent
   separately?
3. **D3 Rendezvous carrier:** helper webxdc (an app card in other clients;
   recommended as default), QR-only, or wait for a core/upstream header?
4. **D4 Relay policy:** only the profile's chatmail iroh relay (recommended), or
   also a community fallback (nine.testrun.org, as in upstream #8490)? n0 is
   ruled out.
5. **D5 Direct vs relay-only default:** allow direct (fast, shows IP to the
   linked contact) with a relay-only toggle (recommended), or relay-only by
   default?
6. **D6 Chip wording and look:** keep the lowercase brand word "iroh"
   (recommended), and the state shapes (outlined, filled + dot, struck).
7. **D7 Local chat:** should `p2p:` chats also appear in the iroh folder and
   carry the chip (recommended: folder yes, keep the wifi badge)?
8. **D8 Settings:** share the typing and presence toggles with Local chat, or
   keep them separate?
9. **D9 Calls:** signalling acceleration only (recommended), or fund the native
   audio research (R2)?
10. **D10 Unreconciled live messages:** keep them forever with a marker, or
    drop them after 30 days?
11. **D11 Large files:** size cap and auto-accept threshold for linked contacts.
12. **D12 iroh version:** build the MVP on 0.35 (matches core and chatmail
    relays today; recommended) and migrate in Phase 5, or start on 1.0 with a
    self-hosted/n0 1.0 relay?
13. **D13 Upstream:** propose a small core API (expose the iroh relay URL;
    sender id on status updates; optional per-chat peer channel) upstream in
    parallel?
