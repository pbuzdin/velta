# PLAN — Velta PWA + restricted WebSocket relay

Status: proposal (2026-10-05). Covers (a) a chatmail relay fork with limited
account creation and WebSocket-only client transport, (b) the Velta update
that produces a standalone PWA served from its own folder.

## 1. Concept read-back and the one hard constraint

The concept: a browser-installable Velta (PWA, own folder/site) talking to a
private chatmail relay that caps account creation and speaks WebSocket only.

The constraint that shapes everything: **browsers cannot open raw TCP**, so a
PWA cannot do IMAP/SMTP at all. Verified against `chatmail/core` main: core
has no WebSocket mail transport and no maintained wasm build (no `websocket`
hits in `src/`, no wasm target). The only WebSocket paths that exist today:

- **iroh relay over wss** — P2P transport; iroh 1.3 compiles for
  `wasm32-unknown-unknown` and its client has a `wasm_browser` WebSocket
  connect path. This is P2P/peer-channel transport, not mail.
- chatmail relay HTTP endpoints (`/new`, `/mxdeliv`, `/ping`) — HTTP, not
  mail submission.

Therefore "transport only via web socket" has two viable readings, and both
are plannable — they differ in who runs the mail stack and who holds keys:

### Architecture A — Gateway PWA (recommended first)

```
PWA (static app/ export)  --wss /ws/rpc (JSON-RPC)-->  gateway on relay fork
                                                        └─ deltachat-rpc-server
                                                           └─ IMAP/SMTP (localhost
                                                              only, not exposed)
```

The PWA becomes a thin JSON-RPC client over one WebSocket. The gateway runs
Velta's (upstream core's) rpc-server per account; the mail stack never faces
the internet. From the browser this is literally "transport only via web
socket". Reuses the existing chatmail account model (addresses, E2EE,
interop with normal Delta Chat clients).

**Trust model, stated plainly:** the gateway hosts the account DB and keys.
Mail stays E2EE between contacts (the relay never sees plaintext in transit),
but the gateway operator is in the webmail position — server-side key
custody. Mitigations: keys encrypted at rest with a user passphrase
(unlocked per session), per-account isolation, no admin plaintext path.
This must be an accepted tradeoff, not an accident.

### Architecture B — Browser P2P (later, non-custodial)

Port Velta's local-chat engine (p2p.rs) to wasm/iroh-wasm: chats flow P2P
over the iroh relay's wss. Keys stay in the browser. No addresses, no SMTP,
no gateway custody — but also no email interop, and a real wasm port of the
engine (tokio/iroh) is its own project. The same PWA shell can grow this as
a second transport later; plan for it, don't build it first.

## 2. Architecture comparison — A vs B

Estimates, not benchmarks — from the architectures themselves. One framing
fact first: browsers cannot send UDP, so iroh in a browser always uses its
WebSocket transport — **in B every message and media byte transits the
iroh relay** (direct peer-to-peer never happens from a browser).

**Performance / response times.** A: one WSS round-trip (~20–100 ms) plus
5–30 ms server-side core work (SQLite, E2EE, all local on the relay box);
an online recipient sees a message in ~0.3–2 s (localhost SMTP → mailbox →
IMAP IDLE), offline recipients on next connect — there is a real mailbox.
Heavy operations (search, backups) run on server hardware, so the PWA feels
snappy on weak phones. B: texts between online peers cost a single relay
hop (~30–100 ms, the fastest possible path); media uploads through the
relay and downloads through it again (bandwidth ×2); delivery is
online-only — the engine queues and flushes on reconnect, an offline peer
waits indefinitely (rebuilding a mailbox here means re-inventing A).

**Features.**

| | A: Gateway | B: wasm P2P |
|---|---|---|
| Addresses / Delta Chat interop | yes, full | none |
| Groups, ephemeral, reply/pin, search | full core feature set | local-chat subset (groups ≤5, 32 MB media, typing) |
| Offline delivery | yes (mailbox) | no |
| Web push / bg notifications | yes (notifier plumbing + VAPID) | no (no server knows you exist) |
| webxdc apps | yes (realtime channels need the iroh-wss path) | no core webxdc |
| Multi-device / backup | yes | limited (no core backup) |
| Key custody | relay operator holds keys (webmail model) | keys in the browser, zero-knowledge server |

**Relay-owner load.** A standard chatmail relay is already cheap
(store-and-forward mail stack, mostly IO; one VPS serves thousands of
accounts). A keeps that whole stack **and** adds a stateful gateway tier:
the real cost is memory — ~50–150 MB per active core account session, or
pool multi-account `deltachat-rpc-server` processes for roughly 1–2 GB per
~100 open accounts, plus spiky CPU on sends/syncs; scaling needs
account→process affinity and sticky WSS sessions. Bandwidth stays
standard-chatmail-shaped (media uploaded once, fetched once). **A is not
lighter than a standard relay — it is a standard relay plus an application
tier.** B drops the mail stack entirely (nginx + iroh-relay + token
service), CPU per connection is trivial and scaling is stateless, but
bandwidth becomes the dominant cost because all media transits the relay
twice. **B is far lighter — as long as no mailbox features (offline
delivery, push, history) are added; each of those walks it back toward A.**

**Practical read.** For "a private Velta web client for real chatmail
users" pick A and accept custody (encrypted at rest, per-session unlock).
For "a zero-knowledge P2P web messenger on your own infrastructure" pick B
and accept the feature ceiling and online-only delivery. This plan
sequences A for v1 and B as a later transport behind the same PWA shell
(OQ-1 is exactly this choice).

## 3. Relay fork plan

Grounded in the chatmail/relay layout we already work in (cmdeploy
deployers + `pins.py`, chatmaild config/ini, nginx templates,
chatmail-metadata). Keep fork patches minimal and upstream-PR-able where
possible (same discipline as PR #1061).

- **R0 — Fork baseline.** Fork `chatmail/relay`, branch `velta-pwa`, decide
  tracking: mirror upstream main, keep our changes as few thematic commits
  (rebase-friendly). Record the fork in `docs/`.
- **R1 — Invite-link account creation** (upstream-PR candidate on its own;
  resolves OQ-3: invites, not just a cap).
  - Data model: `invites` store (token hash, kind single|multi, uses_left,
    expires_at, revoked, note). `chatmail.ini`: `invite_required =
    true/false` (fork default true), `invite_default_max_uses`, optional
    `max_accounts` backstop.
  - Endpoints (all HTTPS on the main origin):
    - `POST /invite` (admin auth): mint single- or multi-use links
      `https://<domain>/i/<token>`; revoke endpoint.
    - `GET /i/<token>`: interstitial page — describes the relay, asks for
      the client URL (Velta PWA origin; remembered in localStorage),
      shows a confirmation step ("Continue to your app at
      pwa.example.org").
    - `GET /i/<token>/go?client=<url>`: validates the client URL (see
      hardening below) and redirects the browser to
      `<client-url>/#/join?t=<ticket>`; mints a short-lived (~10 min)
      AEAD-encrypted claim ticket with the relay's server key
      ({invite_id, exp}, one outstanding claim per invite).
    - `POST /invite/claim {ticket}`: atomic single-use consumption (DB
      transaction, unique claim row — two concurrent claims, one winner),
      creates the account in passdb (same code path as `newemail.py`),
      returns `{addr, password, relay origin}` exactly once. Multi-use
      links decrement `uses_left`. Credentials are never embedded in URLs,
      logs, or the interstitial — the URL carries only the opaque ticket.
  - **Client-URL validation (SSRF / open-redirect hardening, mandatory):**
    https scheme only; reject hosts that are, or resolve to, localhost,
    loopback, private (RFC1918/CGNAT), link-local (169.254.0.0/16,
    fe80::/10), and reserved ranges; **no server-side fetch of the client
    URL ever** — the redirect happens in the user's browser; optional
    `invite_client_allowlist` ini prefix list for locked-down installs;
    the interstitial always displays the target host for confirmation.
  - `newemail.py` / `/new` stays for native clients when
    `invite_required = false`; when true it requires a valid invite too.
  - Tests: offline — mint/claim/expire/revoke, concurrent-claim race,
    invalid/forged ticket, private-host client URL rejected; online
    harness — happy path end to end.
- **R2 — WebSocket gateway** (the fork's centerpiece).
  - New small service (Rust, axum): `/ws/rpc` WebSocket ⇄
    `deltachat-rpc-server` child process (stdio JSON-RPC), one child per
    authenticated account session; idle timeout + reconnect-safe
    (core accounts are DB-backed, sessions are cheap to restart).
  - Auth: bearer token issued at account creation (R1) / printable from the
    `/new` flow; token maps to the account; all RPC over the socket inherits
    that identity.
  - Deploy as a new deployer (clone the `Iroh1Deployer` pattern: pinned
    artifact + systemd unit + config toml), nginx `location /ws/rpc` with
    upgrade headers on the main 443 origin.
  - Keys at rest: per-account passphrase (set during onboarding) encrypting
    the account dir unlock; document what the operator can and cannot see.
- **R3 — "WS-only" mail exposure.** Goal: mail ports not reachable from the
  internet; gateway talks to them locally.
  - Simplest correct shape: bind `smtpd-submission/smtps` to localhost
    (postfix master.cf override in the fork) and firewall 25/465/587; keep
    443 (web + smtp/imap ALPN mux) — the gateway itself can then use
    465/587 locally, remote native clients are out of scope for this fork.
  - Explicitly decide: are native Delta Chat clients allowed on this relay?
    If yes, R3 changes to "keep 465/587 public" and WS-only describes the
    PWA, not the relay. (Open question OQ-2.)
- **R4 — Web Push (optional, strong UX win).** chatmaild already has a
  notification path (devicetoken/notifier). Add a Web Push variant: PWA
  subscribes (VAPID), gateway pushes on `messagenew`. Same notifier queue
  plumbing, new sender. Skip in v1 if timeline is tight.
- **R5 — Tests + docs.** Offline: gateway auth/timeout unit tests, R1 cases.
  Online (existing `cmdeploy/tests/online` harness): create-capped-account,
  WS round-trip RPC, mail send/receive through gateway.

## 4. Velta update plan

Grounded in the app/ tree: `index.html`, `manifest.webmanifest`, `js/`
(`rpc-core.js` isolates JSON-RPC method handling; transports today are Tauri
invoke + in-page MockCore), `css/`, `vendor/`, vestigial `sw.js`, CSP in
three copies (tauri.conf, android conf, AGENTS §8).

- **V0 — PWA folder.** New build step (extend `tools/`): export `app/` →
  `pwa/` dist with (a) real service worker (cache-first for vendor/css/js,
  network-first for index; the v205+ SW was unregistered as vestigial — this
  revives it properly), (b) `pwa-config.js` carrying the WS endpoint +
  branding, (c) CSP copy allowing `wss:` to the relay origin. Hosting:
  same-origin on the fork relay is easiest (no CORS, short CSP); GitHub
  Pages works too but needs relaxed connect-src.
- **V1 — WebSocket RPC transport.** Add `ws-rpc.js` alongside `rpc-core.js`:
  request multiplexing with the oneshot pattern from the #49 web_pending
  work, exponential backoff reconnect, event channel for core events
  (accounts/chatlists arrive the same way MockCore/Tauri deliver them).
  Feature-detect: no `window.__TAURI__` + PWA flag → WS transport.
- **V2 — Onboarding via invite link + auth.** The PWA handles
  `#/join?t=<ticket>` deep links: parse ticket → `POST /invite/claim` on
  the relay origin (pinned inside the ticket) → receive the one-time
  `{addr, password}` → WS handshake → `add_account` (gateway opens the
  account) → profile/nickname modals (reuse #6 / add-profile flow).
  Manual fallback: paste an invite URL (relay origin parsed from it).
  The client-URL step lives on the relay interstitial (R1), not in the PWA.
- **V2.5 — Identity-only backup (separate from chats and media).** Gateway
  RPC wrapping core's imex self-keys export (keys only): a bundle of
  `{addr, password, private keys}`; the PWA encrypts it client-side with a
  user passphrase (WebCrypto AES-GCM) and downloads it. Restore = create
  the account with the same addr/password and import the keys — on this
  relay or any other (lock-in breaker; softens OQ-1: the user holds the
  identity, the operator only the conversations). Chats/media backup stays
  the core full-backup path and remains a separate, explicit action; the
  identity bundle never contains message data. Passphrase loss = identity
  loss — document it in the export dialog.
- **V3 — Capability gates.** Audit every shell-touching feature behind a
  capability flag (pattern already exists via the mock twins): DevTools
  bridge, in-app APK updates (#60), updater banner, Android notification
  channels, background fetch — hidden or web-equivalent (Notification API +
  R4 push) in the PWA. Image/download paths via browser APIs.
- **V4 — Release + versioning.** The new single-source version flow applies:
  `tools/bump.mjs` stays the truth; PWA dist embeds `version.gen.js`
  already; add a `pwa/` publish stage to CI (Pages or relay deploy).
- **V5 — (later) Architecture B transport**: wasm p2p engine behind the same
  rpc-core seam as a third transport. Design note only in v1.

## 5. Suggested order and rough sizes

| Phase | Deliverable | Size |
|---|---|---|
| R1 | invite links + interstitial + claim API | medium, upstream-PR-able |
| V0+V1 | PWA dist + WS RPC against a dev gateway | medium — first demo |
| R2 | gateway service + auth | medium-large |
| V2+V3 | onboarding, capability sweep | medium |
| V2.5 | identity-only backup export/import | small–medium |
| R3 | WS-only exposure hardening | small (ops) |
| R4 | Web Push | medium, deferrable |

## 6. Open questions

- **OQ-1 (acceptance):** Gateway custody (Architecture A) — acceptable for
  this relay's users? If not, only Architecture B remains (P2P-only, no
  addresses).
- **OQ-2 (scope):** Is the fork PWA-only (native clients blocked, R3 as
  written) or PWA-preferred (native clients still welcome)?
- **OQ-3 (accounts):** DECIDED 2026-10-05 — invite links (single- or
  multi-use) per R1, with an optional `max_accounts` backstop.
- **OQ-4 (push):** Is R4 in v1 scope?
- **OQ-5 (upstream):** R1 and (as a proposal) a WS-transport RFC belong
  upstream eventually — do we upstream-first like #1061?
