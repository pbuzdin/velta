# iroh + chatmail transport layer — design and phased plan

Status: proposal, revised 2026-11-22 (first draft 2026-10-06). Docs only, no
code yet. Evidence and citations:
[`research/iroh-layer-research.md`](research/iroh-layer-research.md). Related:
[`agents/p2p.md`](agents/p2p.md) (Velta Loop / local chat engine),
[`research/archive/PLAN-PWA-WEBSOCKET.MD`](research/archive/PLAN-PWA-WEBSOCKET.MD)
(PWA, Architecture C). Tracked as
[#470](https://github.com/pbuzdin/velta/issues/470). Also:
[#469](https://github.com/pbuzdin/velta/issues/469) (Loop on iroh 1.x),
[#454](https://github.com/pbuzdin/velta/issues/454) (streamed Loop transfers),
[#468](https://github.com/pbuzdin/velta/issues/468) (PWA WebRTC Loop).

Pavel's original UX requirement (2026-10-06): "iroh chat and calls will have
separate chat folders and these chats will be marked with an 'iroh' chip near
their avatars".

Direction (2026-11-22): Velta has **one transport layer with two backends**,
both using the same identity and the same Velta keys. **iroh** is the instant
path when both peers are reachable (Loop, calls, live typing, live delivery).
**chatmail** is the fallback for offline delivery, push, multi-device sync,
stable group membership, key verification, and talking to Delta Chat users. A
user can run **Loop-only**, with no chatmail account, for own devices and
friends on the same network.

This is **not** a standalone iroh messenger, and it does **not** replace
chatmail. See §1.6.

---

## 0. Short version

- **What core actually exposes:** iroh only through webxdc realtime (gossip
  per webxdc message, ephemeral node keys, no sender attribution, 128 KiB
  messages, one hidden email per join) and backup transfer. There is no API for
  chat messages, presence or calls over iroh (research §1, §2).
- **Recommended architecture (B), now framed as a transport layer:** **core
  stays the system of record and the authenticated rendezvous wherever a
  chatmail account exists. Velta's existing iroh engine in the Tauri shell
  (`p2p.rs`) is the live data plane.** The engine already powers Loop. It
  gains a relay mode (the chatmail relay's iroh relay) and "links": iroh nodes
  bound to the same Velta identity as the chatmail contact. Every
  user-visible message in a chatmail-backed chat still goes through
  `send_msg` first. The iroh copy is a provisional fast path, de-duplicated by
  Message-ID (`rfc724_mid`). **No change to production `core/`.**
- **Loop-only mode:** a profile with no chatmail account can still use Loop
  for own devices and friends on the same network. Messages then exist only
  on the iroh path, with Loop's sender-side queue. Limits are shown in the
  UI: no push, no server-side multi-device sync, no Delta Chat interop.
- **iroh version:** Loop can move to iroh 1.x as its own dependency, decoupled
  from core's 0.35 (#469). A live path that uses a chatmail iroh relay may
  stay on 0.35 until those relays support 1.x.
- **MVP (Phases 0+1, ~18 days):** 1:1 chats only, desktop and Android:
  - per-chat opt-in link with consent;
  - presence, typing and instant text with email dedup;
  - live "delivered/read" hints;
  - the **iroh folder** and the **"iroh" chip**.
- **Later:**
  - Phase L: Loop-only onboarding (no chatmail account);
  - Phase 2: calls signalling over iroh (WebRTC media stays);
  - Phase 3: large direct files, sharing the streamed Loop transfer engine
    (#454);
  - Phase 4: groups;
  - Phase 5: iroh 1.x — Loop first (#469), then the chatmail-relay path;
  - Phase 6: the PWA. First path is WebRTC Loop for chats and small files,
    no relay (#468). Relay-only iroh in wasm stays a later option.
- **Total:** ~41 working days for Phases 0–5 as estimated in 2026-10-06, plus
  a few days for the transport abstraction and Loop-only onboarding, +4 days
  for a PWA spike, and +15–25 days for a full PWA layer. #454, #468 and #469
  have their own estimates in those issues.

---

## 1. Goals, non-goals, invariants

**Goals:**
- One transport layer with two backends, sharing one Velta identity.
- Lower latency between online Velta peers.
- Live state (typing, presence, delivered/read hints).
- Faster call setup.
- Later: files bigger than email allows, including streamed Loop transfers
  (#454).
- Optional Loop-only mode: use Velta with no chatmail account, for own
  devices and friends on the same network.
- Clear UX: an iroh folder and an "iroh" chip. Loop-only limits are visible.

**Non-goals:**
- Replacing chatmail with a standalone iroh messenger (§1.6).
- Rebuilding store-and-forward, push, multi-device sync, group membership or
  key verification as an iroh-only stack.
- Media over iroh in this plan (research §3.4).
- Patching production `core/`.

**Invariants (become KEEP rules in AGENTS.md when built):**

1. **Chatmail first, when a chatmail account exists.** Every user-visible
   message, call and file stub in a chatmail-backed chat is created through
   core (`send_msg`, `place_outgoing_call` …) before or alongside its iroh
   copy. Nothing in those chats exists only on iroh. The one exception is
   Phase-3 large files: an explicit, consented transfer whose email stub
   always exists.
   **Loop-only chats are the other exception:** they have no chatmail copy,
   because there is no account. They use Loop's own store and sender-side
   queue, and the UI states the limits.
2. **Default off for the chatmail-linked live path.** A fresh install opens no
   sockets for that path. This is the same rule as Loop (AGENTS.md §5.4).
   Loop itself stays the existing opt-in local-chat feature. Loop-only
   onboarding is an explicit choice, not a silent default for people who
   already have a chatmail account.
3. **Degrade to plain chatmail.** A peer without Velta or without the layer,
   a peer that is offline, or any iroh failure: a chatmail-backed chat
   behaves exactly like today. No errors and no lost messages.
4. **The core copy wins** in chatmail-backed chats. When the email copy
   arrives it replaces the provisional iroh copy: content, order and state.
   Core MDNs remain authoritative for read state.
5. **Never use n0 default relays.** Only the profile's chatmail iroh relay,
   or none. Research §4: n0's 0.35 relays end on 2026-12-31, and upstream
   avoids n0 (#5591, #8490). Loop on a LAN needs no relay.
6. **Respect the proxy.** If core has a proxy enabled, the chatmail-linked
   live path stays off, because iroh bypasses proxies
   (`core/src/net/proxy.rs:158-159`). Loop-only, which has no core proxy
   setting, keeps its own policy (LAN-first; no unexpected relays).

---

## 1.5 One transport layer, two backends

```
Velta transport layer
  ├── iroh backend — instant path, when both peers are reachable
  │     Loop (own devices and friends, usually the same network)
  │     live message delivery
  │     live typing and presence
  │     call signalling
  └── chatmail backend — reliable path
        offline store-and-forward
        push notifications
        multi-device sync
        group membership and key verification
        Delta Chat interop
```

Both backends belong to the same profile identity:

- **With a chatmail account:** the long-term identity is the Autocrypt key.
  The iroh node id is bound to it, either by an in-person QR ticket or by an
  authenticated chatmail message (§4.1). Each device of the same person has
  its own node id, all bound to that key.
- **Loop-only, no chatmail account:** the profile still has a long-term
  key, and peers are paired in person with the existing Loop QR flow. If
  that person later adds a chatmail account, the same identity is reused so
  existing Loop chats and new chatmail chats stay one person, not two.

The UI stays one messenger: one chat list, one composer. The transport
layer chooses the path. A chat may be chatmail-backed, Loop-only, or
chatmail-backed with a live iroh overlay (the "iroh" chip).

## 1.6 Why chatmail stays (not a standalone iroh messenger)

iroh is a live transport. It moves data between devices that are online at
the same moment, with optional sender-side queuing (as Loop already does).
It does not, by itself, give Velta the things chatmail already provides:

- **Store-and-forward.** A message has to wait somewhere while the other
  phone is off. That "somewhere" is a server that stores ciphertext and
  hands it over later. Building that on iroh means running such servers
  and defining retention, quotas and abuse policy — in other words, a new
  mail service.
- **Push.** Mobile OS push needs a persistent server-side registration.
  Chatmail already does this. An iroh-only app would only be reachable
  while it is in the foreground, unless we rebuild a push path.
- **Multi-device sync.** Chatmail delivers a copy to each of a person's
  devices and keeps history consistent. An iroh-only design would have to
  invent a sync protocol and a place to park messages for a device that is
  offline.
- **Stable group membership.** Chatmail already has add, remove, and a
  membership that survives offline members. Loop groups are a small,
  online mesh. Scaling that to chatmail-sized groups without a
  store-and-forward path is a new problem.
- **Contact keys and verification.** Chatmail already has Autocrypt,
  fingerprints and verified contact setup. An iroh-only messenger would
  need its own key model and verification UX.
- **Interop.** Every chatmail-backed message is a normal Delta Chat
  message. A standalone iroh messenger talks only to other Velta devices
  that also run that stack.

Rebuilding those pieces is months of work and a new security surface to
audit. The right shape is the one above: iroh for the instant path,
chatmail for everything that has to work when the other device is not
there, and Loop-only as an optional mode for a small, online set of Velta
peers — not a second product.

---

## 2. What an "iroh chat" is

An **iroh chat** is a **normal core 1:1 chat** (Phase 4 adds groups) whose
contact has at least one **linked Velta device**. A linked device is an iroh
node id bound to that contact — and to the same Velta identity — through the
link protocol (§4.1), with the layer enabled on both sides. Its history and
storage are the core chat's; the iroh path adds live delivery and state on
top.

**Loop-only chats** (`p2p:` / `p2pg:`) are the other kind. They already exist
as Velta Loop and have no core chat underneath. In Loop-only mode they are
first-class: they are the only chats that profile has. They still appear in
the iroh folder and keep the wifi badge (D7).

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

**Recommendation: B**, as the live half of the transport layer in §1.5.
The chatmail backend is already core. The iroh backend is Velta's engine,
shared with Loop. Reasons:

1. **Velta already owns a tested iroh engine** with almost every primitive
   needed: persistent identity, authenticated 1:1 QUIC sessions, `Msg`/`Ack`/
   `Typing` frames, offline queue, chunked files, ALPN versioning, unknown-frame
   tolerance and Rust tests (`docs/agents/p2p.md`). Core's realtime channel
   offers broadcast only, without sender identity or backpressure.
2. **No core patches.** Desktop now runs Velta's `velta-rpc-server` (the
   same shim as Android). Any change to production `core/` still means a
   custom core build on every platform, on top of the production core quilt
   and the wasm series, so this layer does not go there.
3. **Identity is stable.** Core's iroh node id changes on every `stop_io`.
   Rendezvous via core would cost one hidden email per chat per restart.
   Velta's node id is long-term and is bound to the profile's Velta key
   (§1.5).
4. **The live data plane is Velta's engine, not core's gossip channel.**
   Today that engine shares iroh 0.35 with core. Loop can take iroh 1.x as
   its own dependency (#469), so the apps may ship two iroh copies until
   core upgrades. The chatmail-relay live path may stay on 0.35 until
   chatmail relays publish 1.x endpoints.

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

### 4.11 Versioning and iroh 1.x

- **`/velta/link/1` on iroh 0.35** for the chatmail-relay live path, for as
  long as chatmail relays speak 0.35.
  - The 0.35 wire is incompatible with 1.x (core PR #8182, relay#1010).
  - Chatmail relays run 0.35 relays today.
  - n0 0.35 relays end 2026-12-31. They are not used anyway.
- **Loop on iroh 1.x first (#469).** Loop is LAN-first and does not need a
  chatmail iroh relay, so it can move to 1.x as its own dependency, decoupled
  from core's 0.35. Measure the extra binary size, and give mixed-version
  peers a clear "update Velta to use Loop" message.
- **Phase 5, after Loop:**
  - Move the link engine to iroh 1.x and `/velta/link/2`, once chatmail
    relays publish 1.x relays (new METADATA key per relay#1010).
  - During the transition, link payloads advertise `iroh`; mismatches show
    "peer needs update".
  - Until core itself moves to 1.x, the apps may ship two iroh copies
    (Loop on 1.x, core and the link path on 0.35). When core upgrades, drop
    the duplicate and share one copy again (#469).

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

Loop already has its own file path, and #454 extends it: zip chunks streamed
in Rust, both ways between desktop and Android, no 2 GB memory cap, a
free-space check, and resume after a drop. Phase 3 for chatmail-backed chats
should reuse that engine, not invent a second one.

1. The sender picks a file above the email limit (or opts in for any size).
2. Velta sends an **email stub** via core: a text message such as "📎 video.mp4
   (180 MB), sent via iroh to Velta", plus `file-offer { stub_mid, sha256, … }`.
3. The receiver accepts (auto-accept up to N MB from linked contacts, D11).
4. The transfer uses the streamed Loop machinery from #454 (chunked writes
   to disk, path checks, cancel, progress). The data lands in a Velta-owned
   blob directory under the accounts dir, or a folder the user picks
   (Android SAF, as in #454). Velta does not create core messages for the
   file: the stub is the core copy, and the file is attached in Velta's view
   of that stub.
5. Restart and resume: from the last good chunk, as in #454.

Loop-only transfers have no email stub and no Delta Chat compatibility
constraint, which is why #454 can drop the 2 GB cap and stream both ways.

---

## 8. PWA (Phase 6)

- Browsers have no UDP, and they cannot open the raw local-network sockets
  that native Loop uses. That is why Loop is hidden in the PWA today.
- **Option P0 (first, #468): WebRTC Loop for chats and small files, with no
  relay.** Browsers swap connection details as encrypted Velta messages (or,
  in Loop-only, as a QR / in-band offer). On the same Wi-Fi the data path is
  usually device to device, encrypted with DTLS. No TURN by default: if a
  direct path fails, say so clearly. PWA-to-PWA comes first; PWA-to-Tauri
  needs a WebRTC transport on the Tauri side (for example `webrtc-rs`).
  Limits: the tab must stay in the foreground; isolated guest networks fail;
  Chromium can stream received files to disk, other browsers need a memory
  cap. Big transfers stay a Tauri feature (#454).
- **Option P1:** the wasm core's own peer channels (option A, gossip).
  Unverified: the wasm series keeps iroh but never runs it.
- **Option P2: port the link engine (protocol subset: text, typing,
  presence, call signalling) to wasm on iroh 1.x**, after Phase 5. This is
  the path for a *cross-network* live overlay in the PWA. In a browser, iroh
  is relay-only over WebSocket and stays end-to-end encrypted (research §5).
  Interop with native peers goes through a shared relay. Calls in the PWA
  use browser WebRTC plus TURN, which already works.
- **Gate:** PLAN-PWA Architecture C landing first
  (`docs/research/wasm-core-landing-checklist.md`). #468 can start without
  waiting for an iroh wasm port.

---

## 9. Phases, estimates, acceptance criteria

Estimates in working days for one developer familiar with p2p.rs.

| Phase | Content | Days |
|---|---|---|
| **0. Spikes** | S1 chatmail iroh-relay URL derivation plus relay mode in a test endpoint (desktop ↔ Android on different networks: connect rate, direct upgrade rate, RTT). S2 helper xdc round trip; rendering in DC Desktop and DC Android; status updates without `info` stay silent; deleting the xdc. S3 relay-only / IP-hiding feasibility on iroh 0.35. S4 latency baseline (email vs iroh) and Android battery for 1 h in the foreground | **3** |
| **1. MVP: 1:1 live layer** | 1.0 transport API over the existing engines (one send/receive surface, two backends, shared identity) (2). 1.1 per-profile endpoint, relay mode, settings, proxy gate (1.5). 1.2 link protocol (xdc + QR), registry, consent, revoke (2.5). 1.3 session auth, dial policy, presence (1.5). 1.4 `live` envelope, rfc724_mid dedup and reconcile, notification dedup incl. Android poller (3). 1.5 typing, live ack/read hints (1). 1.6 UI: iroh folder, avatar chip, header status, a11y/RTL/forced colours (1.5). 1.7 tests and two-device matrix (2) | **15** |
| **L. Loop-only mode** | Onboarding with no chatmail account; reuse the same identity later if an account is added; UI for the limits (no push, no server-side multi-device sync, no Delta Chat interop); existing Loop chats stay first-class | **5** |
| **2. Calls signalling** | ring/answer/ice/end/busy frames, `calls.js` `fastSignal`, reconciliation rules, iroh filter in Calls, tests | **6** |
| **3. Large files** | stub plus offer/accept, reuse the streamed Loop engine from #454, consent and auto-accept policy, UI progress/retry | **5** |
| **4. Groups** | membership from core plus 1:1 links, `group-live` mesh, dedup, typing in groups, cap 8 | **9** |
| **5. iroh 1.x** | Loop on 1.x first (#469, own estimate). Then the link engine on 1.x, `/velta/link/2`, relay discovery for 1.x relays, mismatch UX, optional dual stack until core upgrades | **5** (link path; Loop in #469) |
| Subtotal 0–5 + L | 2026-10-06 total was 41; +2 for the transport API and +5 for Loop-only | **48** |
| **6. PWA** | WebRTC Loop spike first (#468); later, wasm engine subset over a relay (4 d) and a full layer after PWA C lands (15–25 d) | 4 + 15–25, plus #468 |
| R1 (optional) | core patch series spike (invisible header; MIME-over-iroh dedup via `receive_imf`), apply-on-copy only, plus an upstream write-up | 10 |
| R2 (optional) | desktop native audio over iroh datagrams, feasibility only | 5 |

**MVP acceptance criteria (Phases 0+1):**

1. With the layer off (default): no new sockets, identical behaviour. Pinned by
   a test, as for Loop.
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
   enabled in core, the chatmail-linked live path refuses to start.
8. Revoke on either side drops the session within 5 s and removes the chip.

**Loop-only acceptance criteria (Phase L):**

1. A new profile can be created with no chatmail account and can use Loop
   with another Velta device on the same network.
2. The UI states the limits: no push, no server-side multi-device sync, no
   Delta Chat interop.
3. Adding a chatmail account later reuses the same identity. Existing Loop
   chats remain.
4. A Loop-only profile never contacts an n0 relay.

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
| R1 | iroh 0.35 end of life; the 1.x wire break splits peers (research §4, #469) | Loop upgrades first (#469) with a clear mixed-version message; link path waits for chatmail 1.x relays; never rely on n0 |
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
| R13 | Loop-only users expect push, history on a new device, or Delta Chat interop | clear limits in onboarding and in the chat; adding a chatmail account later reuses the same identity |

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
12. **D12 iroh version:** Loop on iroh 1.x first as its own dependency
    (#469; recommended). Keep the chatmail-relay live path on 0.35 until
    those relays support 1.x, then migrate it in Phase 5. Do not start the
    chatmail-relay path on a public n0 1.x relay.
13. **D13 Upstream:** propose a small core API (expose the iroh relay URL;
    sender id on status updates; optional per-chat peer channel) upstream in
    parallel?
14. **D14 Loop-only onboarding:** a first-run choice ("use without a
    chatmail account", recommended) for own devices and friends on the same
    network, or only as an advanced setting after a chatmail account exists?
    Adding a chatmail account later must reuse the same identity (§1.5).
