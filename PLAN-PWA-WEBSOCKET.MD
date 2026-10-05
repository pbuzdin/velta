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

## 2. Relay fork plan

Grounded in the chatmail/relay layout we already work in (cmdeploy
deployers + `pins.py`, chatmaild config/ini, nginx templates,
chatmail-metadata). Keep fork patches minimal and upstream-PR-able where
possible (same discipline as PR #1061).

- **R0 — Fork baseline.** Fork `chatmail/relay`, branch `velta-pwa`, decide
  tracking: mirror upstream main, keep our changes as few thematic commits
  (rebase-friendly). Record the fork in `docs/`.
- **R1 — Limited account creation** (upstream-PR candidate on its own).
  - `chatmail.ini`: `max_accounts` (hard cap) and optional `invite_tokens`
    (file of single-use tokens; `/new` requires one when enabled).
  - `newemail.py` (CGI): check live-account count in `passdb` and token
    before creating; return a proper error page/state.
  - nginx: rate-limit block for `/new` already exists for self-signed mode —
    extend with the cap; add a JSON error shape the PWA can render.
  - Tests: offline `test_newemail` cases (cap reached, token invalid/used);
    no new daemons.
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

## 3. Velta update plan

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
- **V2 — Onboarding + auth.** Token entry (paste / `dcaccount:`-style link
  from the R1 flow) → WS handshake → `add_account`/`select_account` RPCs.
  Reuse the existing onboarding modals (nickname #6, add-profile flow).
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

## 4. Suggested order and rough sizes

| Phase | Deliverable | Size |
|---|---|---|
| R1 | capped/invite-gated `/new` | small, upstream-PR-able |
| V0+V1 | PWA dist + WS RPC against a dev gateway | medium — first demo |
| R2 | gateway service + auth | medium-large |
| V2+V3 | onboarding, capability sweep | medium |
| R3 | WS-only exposure hardening | small (ops) |
| R4 | Web Push | medium, deferrable |

## 5. Open questions

- **OQ-1 (acceptance):** Gateway custody (Architecture A) — acceptable for
  this relay's users? If not, only Architecture B remains (P2P-only, no
  addresses).
- **OQ-2 (scope):** Is the fork PWA-only (native clients blocked, R3 as
  written) or PWA-preferred (native clients still welcome)?
- **OQ-3 (accounts):** Hard cap, invite tokens, or both? Cap alone is
  simpler; tokens are better for a private deployment.
- **OQ-4 (push):** Is R4 in v1 scope?
- **OQ-5 (upstream):** R1 and (as a proposal) a WS-transport RFC belong
  upstream eventually — do we upstream-first like #1061?
