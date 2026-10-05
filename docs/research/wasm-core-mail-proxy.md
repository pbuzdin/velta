# WASM chatmail core in the browser + mail proxy: research for Velta PWA

**Status:** spike starting **2026-10-05** (see also
[`wasm-core-mail-proxy-spike.md`](wasm-core-mail-proxy-spike.md) for day-by-day
build notes). This file is the research baseline copied into the repo; factual
content is kept, workspace-local paths from the original scratch notes are
rewritten so they make sense in-repo.

Date of research: 2026-10-05. Scope of the original pass: read-only research;
no production app code was changed. Inputs: this Velta tree (vendored core
2.62.0 in `core/`, `PLAN-PWA-WEBSOCKET.MD`), `chatmail/core`, `chatmail/relay`
(+ fork `pbuzdin/relay`), web/GitHub search, and a dry `cargo check` of the
vendored core for wasm targets (logs were produced outside the repo during
research).

**Headline:** the PLAN's line "core has no wasm build" is still true upstream, but it is
**not** an open research question any more. A third-party prototype,
**experintellia/slothfulchat-web**, already runs chatmail core compiled to
`wasm32-unknown-unknown` in a browser worker. It uses OPFS-persisted SQLite and does
IMAP/SMTP through a WebSocket→TCP bridge, with TLS terminating *inside wasm*. Its e2e
test configures two chatmail accounts in the browser and passes an encrypted alice→bob
round-trip. Upstream is also moving: chatmail/relay PR #1030 adds websockify `/imap` and
`/smtp` endpoints, and chatmail/core issue #8559 covers WebSocket transport in core. So
the minimal-effort path is to **reuse and forward-port**, not to design from scratch.

---

## 1. Trust model (be precise about who sees what)

Parties: **(C)** the origin that serves the PWA code (HTML/JS/wasm), **(P)** the WebSocket
proxy/bridge operator, **(R)** the chatmail relay operator, **(N)** the network.

### What stays client-side
- The account DB (SQLite on OPFS), the OpenPGP secret keys, the blobs, and the IMAP/SMTP
  password all live in the browser origin's storage. No server holds them at rest. A
  seizure or breach of P or R yields no keys and no decrypted history. This is the real
  gain over Architecture A, where the gateway holds DB + keys (webmail model).

### What the proxy sees depends on where TLS terminates
| Proxy design | P sees | P cannot see |
|---|---|---|
| **G: generic byte tunnel, TLS inside wasm** (slothfulchat `ws-tcp-proxy`, mailiner, Wisp/epoxy) | client IP, target IP:port, DNS names it resolves, timing, byte volumes, connection lifetime | IMAP LOGIN/password, mailbox names, FETCH bodies, headers. All of it is inner TLS to the mail server, validated against webpki roots |
| **T: TLS terminated at proxy** (proxy speaks TLS to the relay, browser speaks plain IMAP over WSS to proxy) | everything above **plus** the IMAP/SMTP plaintext: AUTH password, envelope From/To, Message-IDs, sizes, flags, which messages you fetch or delete | OpenPGP-encrypted payload (message text, attachments, protected headers) |
| **R-native: websockify on the relay** (relay PR #1030: nginx `wss://relay/imap` → websockify → `localhost:143`; `/smtp` → `localhost:587`) | P **is** R, so there is no new party. nginx terminates WSS on the relay host. Submission on 587 enforces STARTTLS (`smtpd_tls_security_level=encrypt`, `smtpd_tls_auth_only=yes` in relay `master.cf.j2`), so SMTP gets an inner TLS layer anyway. For IMAP on 143, Dovecot normally treats loopback as "secured", so plain IMAP inside WSS probably works and the client may still STARTTLS. Verify this | Same as a native Delta Chat client today: R sees login + metadata + ciphertext, never plaintext bodies |

Careful notes:
- **OpenPGP (Autocrypt/SecureJoin) protects message content end-to-end in every design.**
  Chatmail relays reject unencrypted mail, so even a design-T proxy that steals the password
  cannot read message bodies. With the password it *can* log in, read metadata, delete or
  hold mail, and send. Recipients would get mail that is not signed by your key, and
  chatmail/Delta Chat flags or rejects that. It cannot impersonate your key.
- In design G, a malicious proxy is an active MITM *on the TCP path only*: it can drop,
  delay or redirect. Redirecting does not break confidentiality because core validates
  certificates strictly. Core's `ConfiguredCertificateChecks::Automatic` means
  `strict_tls = !provider.disable_strict_tls` (`core/src/transport.rs:434-443`), and
  chatmail relays are strict. The exception is a user who picks "accept invalid
  certificates". The proxy also answers DNS (`/dns/{host}`), which is safe under strict
  TLS but a DoS and traffic-analysis lever.
- **The biggest caveat is not the proxy but C, the code origin.** Whoever serves the
  PWA's JS/wasm can ship an update that reads the keys out of OPFS. "Keys in the browser"
  turns *passive server-side custody* (Architecture A) into an *active, targeted attack
  capability for the code host*. That is a real improvement, but it is not
  zero-knowledge-by-construction. This is the same model as Proton web / any web E2EE
  app. Mitigations: self-host the PWA on Pavel's own origin; a service worker that pins
  the installed version and asks before updating; reproducible builds with published
  hashes; a strict CSP (`script-src 'self' 'wasm-unsafe-eval'`).
- **Browser storage:** there is no DB encryption at rest. sqlcipher's vendored OpenSSL
  does not build for wasm; a sqlite3mc cipher via sqlite-wasm-rs is possible later.
  Storage is origin-sandboxed, but device compromise or a malicious extension exposes it.
  Storage can also be evicted: call `navigator.storage.persist()`; Safari deletes
  script-writable storage of non-installed sites after 7 days without interaction, while
  home-screen PWAs are exempt. An identity/key backup UX is mandatory (see V2.5 in the
  PLAN).

**Distilled:** wasm core + design-G proxy (or relay-native websockify) gives
*no server-side key or DB custody*. The proxy learns connection metadata only; the relay
learns what it learns from any native client. The residual trust sits in the PWA code
origin and in browser storage durability.

---

## 2. Prior art

| Project | What it is | Relevance |
|---|---|---|
| **experintellia/slothfulchat-web** (GPL-3.0 overall; core patches dual `MPL-2.0 OR GPL-3.0`; core-wasm wrapper MPL-2.0; ws-tcp-proxy Unlicense). Created 2026-07-07, active (pushed 2026-10-05), "experimental ai-coded" | Chatmail core → wasm32 in a Web Worker, behind the standard `@deltachat/jsonrpc-client` API; deltachat-desktop frontend as a PWA; Node `ws-tcp-proxy` (~200 lines: `/dns/{host}`, `/tcp/{ip}/{port}`, ports 143/465/587/993 only, `CHATMAIL_ALLOWLIST`) | **Direct prior art for exactly this task.** FINDINGS.md: M1 (core compiles, `get_system_info` in a tab) took 4 patches / 853 lines. M3 (two accounts on nine.testrun.org configured in wasm, encrypted alice→bob over the WS tunnel, TLS in wasm) took 7 patches / ~2100 lines. M5 (OPFS persistence) took 9 patches / ~2500 lines, plus `tokio-wasm-shim` (~2.4k lines now) and 3 tiny vendored crate forks (async-imap, mail-builder, astral-tokio-tar). Now 35 core patches (many are features unrelated to wasm). **Pinned at core `446cdabd` (2.54.0-dev)**, so it is 8 releases behind Velta's 2.62.0 |
| deltachat-desktop "Browser Edition" (PR #4222, blog 2025-05-22) | Desktop UI in a browser, with core on a server via WebSocket JSON-RPC | That is Architecture A (server custody); the blog explicitly calls this out as breaking device-to-device E2EE |
| support.delta.chat thread #3789 (2025-05) | Upstream's own blocker list: tokio on wasm, SQLite in browser, no TCP → WS proxy (could live in the chatmail relay), blobs, OpenSSL. link2xt: "OpenSSL … can be completely omitted for WASM builds" | Confirms the blockers; all are addressed in slothfulchat |
| chatmail/core #8559 (open, 2026-08-11) "Add WebSocket support" | Plan: new `Socket::WebSocket` security variant + ws path in login params, using tungstenite, *native* first. link2xt: "for the WASM target all the code for establishing connections should be compiled out … TLS will have to stay". hpk42 warns that a new enum variant can break multi-device transport sync | Upstream is heading to "core speaks IMAP over WSS". If that lands, a wasm build needs only a browser-WebSocket stream instead of a custom proxy |
| chatmail/relay PR #1030 (open, 2026-07-29) "feat: setup websockify" | nginx `location /imap`, `/smtp` → websockify → `localhost:143` / `localhost:587` | Relay-native WS endpoint, so no third-party proxy. Already mirrored in `pbuzdin/relay` as branch `link2xt/websockify`. Needs CORS / Origin rules for web clients (noted in the PR) |
| chatmail/core #1128 (2019, closed) | wasi discussion; link2xt 2024-12: `wasm32-wasip2` build fails on socket2 | Historic |
| mailiner-net/mailiner-rs | Rust/Dioxus IMAP client in wasm + Rust `ws-tcp-proxy`, TLS in the browser | Same proxy pattern (design G) |
| claw-transport / Wisp protocol + epoxy-tls (Mercury Workshop) | Generic WS-multiplexed TCP tunnel with TLS in the browser | Alternative to a bespoke bridge; multiplexes many TCP streams over one WS |
| madmail WebIMAP/WebSMTP | Mail over HTTPS REST (long-poll), no bridge needed; slothfulchat supports it as the `webimap` transport (core patch 0011, ~830 lines) | Shows the "HTTP-native mail access" alternative; not chatmail/relay |
| JMAP + RFC 8887 (JMAP over WebSocket), e.g. Stalwart | Browser-native mail protocol | Upstream mentions it as a long-term option; core has no JMAP client, so a big project |
| Proton / Mailvelope | OpenPGP in the browser; Proton stores the private key server-side, encrypted with the user's password | Same code-origin trust caveat; Proton's model ("server stores an encrypted key blob") is a middle ground for Architecture A |
| iroh `wasm_browser` (≥0.33; iroh 0.35 is in core) | Browser iroh is relay-only over WebSocket, E2EE to the peer | Basis of Architecture B; slothfulchat found iroh 0.35 compiles for wasm32 as-is (linked but unused) |
| WICG Direct Sockets | Raw TCP from the web | Only for Isolated Web Apps (Chrome); not usable for a normal PWA |

---

## 3. Core wasm blockers, with evidence

### 3a. Dry `cargo check` on Velta's vendored core (2.62.0)
Setup: rustup stable 1.99.0 + `wasm32-unknown-unknown`, `wasm32-wasip1`; separate target dir
(separate cargo target dir outside the tree); `--locked --keep-going -p deltachat --lib`. Logs:
dry-check logs from the research pass (not checked into this repo). The box has no
`clang`, which wasm C builds need anyway.

**wasm32-unknown-unknown: the first wave is all at the dependency level, before any core code compiles.**
| Failing crate | Error | Pulled in by | Fix (as in slothfulchat) |
|---|---|---|---|
| `mio` (48 errors) | no `sys` for wasm | `tokio` features `net`/`process`/`rt-multi-thread`/`fs`, enabled by core itself (`rt-multi-thread`, `fs`), `async-imap` `runtime-tokio` (→ `tokio/net`, unused), `shadowsocks` (`net`, `process`), `fast-socks5`, `hyper-util` | tokio facade crate (`tokio-wasm-shim`): real tokio on native; on wasm, sync/io/macros plus wasmtimer time, `spawn_local` tasks, an in-memory+OPFS `fs`, and `net` stubs. Vendored async-imap with the `tokio/net` line dropped |
| `socket2` 0.5.9 | "Socket2 doesn't support the compile target" | `fast-socks5`, `shadowsocks` | target-gate SOCKS5/shadowsocks out (stub `net/proxy.rs` on wasm) |
| `openssl-sys` (build script) | vendored OpenSSL `Configure` fails for wasm | `libsqlite3-sys` (bundled-sqlcipher-vendored-openssl, the `vendored` default feature), `native-tls` (`async-native-tls`) | drop sqlcipher on wasm; rusqlite 0.37 → 0.40 (wasm uses `sqlite-wasm-rs`); drop async-native-tls on wasm; rustls only (OpenSSL is used only for non-strict TLS) |
| `ring` (build script) | needs `clang` for wasm C | rustls, iroh, quinn, rcgen | install clang at build time (also needed by sqlite-wasm-rs) |
| `fd-lock` (22 errors) | no fs locks on wasm | `core/src/accounts.rs` | reuse the existing iOS no-lockfile `cfg` |
| `getrandom` 0.3 | needs `wasm_js` cfg | iroh, rand_core 0.9 | `rustflags = --cfg getrandom_backend="wasm_js"` + `wasm_js` feature; getrandom 0.2 `js` |
| `uuid` | needs randomness feature | core | `uuid` `js` feature on wasm |

**wasm32-wasip1** is worse: tokio refuses ("Only features sync,macros,io-util,rt,time are
supported on wasm"); iroh deps `hostname`, `netdev`, `ntimestamp` fail; plus
socket2/openssl/fd-lock/ring. WASI is the wrong target for a browser. iroh supports only
`wasm32-unknown-unknown` + wasm-bindgen.

### 3b. Second wave (not reached by `cargo check`; from slothfulchat FINDINGS, with counts from Velta core `src/`)
- **tokio surface in core:** `tokio::fs` in 30 files (76 hits), `tokio::time` in 20 (34),
  `tokio::spawn` in 18 (27), `block_in_place` in 9 (18), `spawn_blocking` in 3 (4),
  `tokio::net` in 4 (5). All of it is absorbed by the facade crate, not by editing call sites.
- **Clocks:** `std::time::SystemTime::now()` / `Instant::now()` **panic at runtime** on
  wasm32-unknown-unknown (18 files / 31 hits in core, plus dependencies). Seen one panic at
  a time: rustls cert validation (needs a custom `TimeProvider`), deltachat-ratelimit,
  rPGP (`wasm` feature), chrono (`wasmbind`), async-imap IDLE timeout, mail-builder
  (needed a fork). This "time minefield" was the main M3 cost.
- **std::fs:** `blob.rs` does sync `std::fs` inside `block_in_place`; `Path::exists()` is
  always false on wasm (11 call sites). These were routed through the memfs shim.
- **Single thread:** no real `spawn_blocking`, so PGP keygen/encrypt/decrypt block the
  worker (~1 s on phones). slothfulchat later added a crypto web-worker pool (core patch
  0029, ~530 lines). This is optional for a demo.
- **HTTP:** `net/http.rs` (hyper) is stubbed; patch 0010 routes it through `fetch()`.
  Needed for `DCACCOUNT:https://…/new` (QR invites), autoconfig, push. **CORS:** the relay's
  `/new` (or the PLAN's invite-claim endpoint) must send CORS headers for the PWA origin,
  or HTTP must go through the proxy.
- **Toolchain:** rusqlite 0.40 uses `cfg_select!`. slothfulchat pins a dated nightly, but
  I checked that **stable rustc 1.99.0 compiles `cfg_select!`**, so nightly should no
  longer be required. Release builds only: a dev wasm (57 MB) crashes the tab, and release
  is ~17 MB before wasm-opt.
- **Velta-specific:** Velta already carries 13 anchor-based core patches
  (`tools/apply-core-patches.py`). A wasm stack would add a second patch layer that has to
  be re-applied on every core upgrade. slothfulchat has *not* rebased from 2.54 in about
  3 months, which shows that cost is real.
- **Iroh-dependent features** (webxdc realtime, backup transfer): iroh 0.35 compiles, but
  in a browser it is relay-only. Velta's own local-chat engine (`velta-app/src-tauri/src/p2p.rs`,
  ~7k lines) is Tauri-side, not core, and is not part of this port.

### 3c. Verdict on "can it compile today?"
- **Unmodified: no**, for either wasm target (evidence above).
- **With a known, bounded patch set: yes.** That has been demonstrated end-to-end at core
  2.54 with about 10 wasm-relevant patches (~2.5k lines) + one facade crate + 3 tiny forks.
  The remaining risk is forward-porting to 2.62 and keeping up with core releases, not
  feasibility.

---

## 4. Proxy design

Recommended order of preference for Velta + `pbuzdin/relay`:

1. **Relay-native websockify (PR #1030), with STARTTLS inside the WSS stream.**
   - No new trust party; deploys with the relay (branch `link2xt/websockify` already in the fork).
   - Core needs a wasm connect path to `wss://<relay>/imap` and `wss://<relay>/smtp`
     (browser `WebSocket` → duplex stream; slothfulchat's `src/net/ws_tcp.rs` is ~150
     lines and can be adapted). STARTTLS inside the stream keeps P blind even on the relay
     host (submission already enforces STARTTLS).
   - To add on the relay: CORS/`Origin` allowlist for the PWA origin on `/imap` and `/smtp`;
     connection caps.
   - **Check per-IP limits:** every WS user reaches postfix and dovecot from 127.0.0.1.
     Watch `smtpd_client_connection_count_limit = max_smtp_connections//5` and dovecot
     auth-failure penalties. Also, `mua_helo_restrictions` has `permit_mynetworks` and
     `mynetworks = 127.0.0.0/8`, so HELO checks are skipped for WS users. Prefer
     PROXY-protocol / XCLIENT, or accept and document it.
   - websockify is Python. That is fine to start; the PR discussion already questions its
     performance.
2. **Generic design-G bridge** (slothfulchat `ws-tcp-proxy`, or a ~200-line Rust/axum
   equivalent) on the PWA's website origin, with a strict allowlist (your relay
   domains/IPs only; ports 465/993/443-ALPN, **never 25**), an Origin check, per-IP rate
   limits, and no logging of targets beyond host. TLS stays in wasm. Works with *any*
   chatmail relay without relay changes, which is useful for interop and testing.
3. **Avoid design T** (TLS terminated at the proxy). It hands the proxy the password and
   IMAP metadata, and there is no upside.

Longer-term: if core #8559 lands (native `Socket::WebSocket` + ws path), the wasm build
only has to supply a browser-WebSocket stream for that variant, and a "website proxy" is
no longer needed for relays that have #1030.

---

## 5. SQLite in the browser: what core needs
- **Keep rusqlite**; do not switch to sql.js or the JS sqlite-wasm. rusqlite **0.40**
  (2026-06) uses `sqlite-wasm-rs` on `wasm32-unknown-unknown` by default (feature
  `ffi-sqlite-wasm-rs`), so core's SQL code is unchanged. Core is on 0.37: the bump is
  nearly API-compatible (one `usize: ToSql` cast).
- **VFS:** `sqlite-wasm-vfs` **sahpool** (OPFS SyncAccessHandle pool) gives full
  durability with no COOP/COEP requirement, but must run in a **dedicated worker** and
  holds handles exclusively. So: **single tab** (add Web Locks leader election), and core
  cannot boot inside a service worker (so no decrypt-on-push). Alternatives: in-memory
  (demo only), `relaxed-idb` (IndexedDB, relaxed durability, any context).
- **Pool details:** core opens `N_DB_CONNECTIONS` connections; sahpool slots must be sized
  (slothfulchat: `max(32, 2N+8)`, plus a sweep for orphaned files). OPFS commits are slow
  (~1.7 s of migrations per new account); slothfulchat seeds new DBs from a pre-migrated
  template.
- **Blobs:** core writes files. Use a memfs + OPFS write-through mirror, served to
  `<img>` by a service worker. Imports must drain before reporting success.
- **Encryption at rest:** none at first. sqlite-wasm-rs has a `sqlite3mc` feature, a
  possible future route; backups are unencrypted on wasm (no `sqlcipher_export`).
- **Build:** `clang` on the build machine (sqlite-wasm-rs compiles SQLite C).

---

## 6. Minimal vertical slice ("create account, send one encrypted message, receive one, keys only in browser")

Shape: Velta core 2.62 + a wasm patch subset → `core-wasm` (wasm-bindgen wrapper over
`deltachat_jsonrpc::CommandApi`, in a dedicated worker) → a new Velta transport
`worker-wasm` in `app/js/transport.js`. Velta's transport contract is already
line-oriented (`setReceiver` / `send(line)`), so this is ~100 lines → proxy
(slothfulchat bridge locally, or relay websockify) → chatmail relay.

Demo script (mirrors slothfulchat `test-networking.mjs`):
1. Two browser contexts (alice, bob). Each creates an account with `dcaccount:<relay-domain>`.
   The bare-domain form generates credentials locally and needs no HTTP.
2. Key exchange: `makeVcard(bob)` → `importVcardContents(alice)` (chatmail mandates E2EE;
   a bare `createContact` cannot send). Or scan a SecureJoin QR.
3. alice sends; bob receives via IMAP IDLE; assert the text. Check OPFS (or memory) holds
   the DB, and that the proxy log shows only TLS bytes.

Blockers ranked by effort, for this slice only:
| # | Blocker | Effort if reusing slothfulchat | From scratch |
|---|---|---|---|
| 1 | Forward-port the wasm build patches (0001-0007 ≈ facade wiring, rusqlite 0.40, clocks, fs, ws tunnel) from 2.54 to 2.62, coexisting with Velta's 13 patches | 4-7 days | 2-3 weeks (the time minefield is runtime-discovered) |
| 2 | Facade crate `tokio-wasm-shim` + vendored async-imap / mail-builder forks | reuse as-is (MPL/compatible) | 1 week |
| 3 | WS transport in core (bridge path or relay `/imap` path, STARTTLS) | 1-2 days | 3-5 days |
| 4 | wasm-bindgen wrapper + worker + Velta `worker-wasm` transport | 1-2 days | 3-4 days |
| 5 | Proxy: run slothfulchat bridge locally, or deploy the `link2xt/websockify` branch on a test relay + CORS | 0.5-1 day | 1-2 days |
| 6 | Build plumbing (clang, wasm-pack, release profile, stable 1.99) | 0.5 day | 1 day |
| 7 | OPFS persistence (optional for the slice; memory VFS is enough to prove it) | +2-3 days | +1 week |

---

## 7. Effort estimate (one experienced Rust+web engineer; ranges, not commitments)

| Deliverable | Reusing slothfulchat patches | Clean-room | Notes |
|---|---|---|---|
| **(a) Spike / plan only** | **3-5 person-days** | 1-2 pw | Build slothfulchat at its pin, run its e2e against your relay via its bridge *and* via the websockify branch, measure bundle size, memory and boot time, decide licensing, write an ADR + patch-port plan for 2.62 |
| **(b) Proxy + wasm proving connect + minimal slice** | **2-3 person-weeks** | 5-8 pw | "Connect" (configure succeeds) is about 60% of it; the encrypted round-trip adds the rest |
| **(c) Production-shaped wasm core + proxy + Velta PWA glue** | **3-5 person-months** initial, then **~0.5-1 pw per core release** to rebase the stack | 5-8 pm | Includes: OPFS persistence hardening (single-tab lock, eviction, `persist()`, durable blob mirror), crypto offload worker, HTTP via fetch + CORS on relay endpoints, backup/identity export UX, capability gates (no webxdc / iroh / local-chat / push / sqlcipher), hardened proxy deploy (relay deployer, Origin/CORS, limits), CI wasm build + e2e, CSP and code-integrity story, iOS Safari quirks (slothfulchat hit an OPFS corruption bug on iOS) |

Comparison, using the same yardstick:
| | Effort to v1 | Custody | Interop | Main limits |
|---|---|---|---|---|
| **A: Gateway** (PLAN R1+R2+V0-V3) | ~1.5-2.5 pm (+ R4 push ~0.5 pm) | Server holds DB + keys (mitigated by passphrase-at-rest) | full | operator custody, ~50-150 MB RAM per active account server-side, stateful scaling |
| **wasm core + proxy (this doc)** | ~3-5 pm (2-3 pw to a demo) | keys + DB in the browser; proxy sees metadata only; code origin is the residual trust | full chatmail interop | no push when closed, single tab, browser storage durability, ~17 MB+ wasm, patch-stack maintenance per core release |
| **B: iroh-wasm local-chat** | ~1.5-3 pm (port the ~7k-line `p2p.rs` engine + storage + glue) | keys in the browser | none (no addresses) | online-only, all traffic via the iroh relay, feature ceiling |

Note: wasm-core costs more than A, but it is the only option that combines "chatmail
addresses + interop" with "no server key custody". Its big *upfront* risk (does core run
in a browser at all?) has already been retired by slothfulchat. What remains is
engineering and maintenance.

---

## 8. Recommendation
1. **Do the 3-5 day spike first (a).** Reproduce slothfulchat's M3 e2e against a test
   deployment of `pbuzdin/relay` branch `link2xt/websockify`, both through the generic
   bridge and through relay `/imap` + `/smtp`. Record bundle size, cold boot, and memory
   on a phone. Decide licensing: reusing core patches under MPL-2.0 is fine; do **not**
   pull the GPL web-app or desktop frontend into Velta.
2. **If the spike is green, build (b) as a new Velta transport** (`worker-wasm`) behind the
   existing `rpc-core.js` seam, with Velta's 13 core patches + the forward-ported wasm
   subset (0001-0007, 0010, plus 0032/0033 when persistence lands). Keep the proxy
   relay-native (websockify + STARTTLS inside) so no new party is introduced.
3. **Track upstream:** comment on / follow chatmail/core #8559 and relay #1030. Their
   landing shrinks the custom networking patch to "browser WebSocket stream for
   `Socket::WebSocket`". An upstreamable "wasm compiles in CI" PR (target-gating only)
   would cut the per-release rebase cost the most.
4. **Positioning vs the PLAN:** wasm-core can replace Architecture A's custody tradeoff
   (OQ-1) for users who refuse server custody. A remains cheaper and gives push. A sensible
   sequence: ship the A gateway or the wasm demo first depending on OQ-1, and keep the
   other behind the same transport seam. Architecture B stays orthogonal (P2P, no
   addresses).

### Spike status
A 3–5 day spike started **2026-10-05** to validate `experintellia/slothfulchat-web` + `pbuzdin/relay` branch `link2xt/websockify`. Progress notes: [`wasm-core-mail-proxy-spike.md`](wasm-core-mail-proxy-spike.md). Do not copy the GPL web app into Velta; MPL core patches may be referenced/listed.

### Evidence index
- dry-check logs from the research pass (not checked into this repo) (dry checks of Velta core 2.62.0)
- slothfulchat-web: https://github.com/experintellia/slothfulchat-web (FINDINGS.md, PLAN.md, DESCOPED.md, PATCHES.md, `patches/core/*`, `packages/ws-tcp-proxy`)
- chatmail/core #8559 https://github.com/chatmail/core/issues/8559 ; #1128 https://github.com/chatmail/core/issues/1128
- chatmail/relay PR #1030 https://github.com/chatmail/relay/pull/1030 (diff: nginx `/imap`→127.0.0.1:8143→localhost:143, `/smtp`→8587→localhost:587)
- Delta Chat browser edition blog https://delta.chat/en/2025-05-22-browser-edition ; forum https://support.delta.chat/t/3789
- rusqlite 0.40 wasm (ffi-sqlite-wasm-rs), sqlite-wasm-rs / sqlite-wasm-vfs (sahpool, relaxed-idb)
- iroh browser docs https://docs.iroh.computer/languages/wasm-browser
- mailiner-rs https://github.com/mailiner-net/mailiner-rs ; claw-transport (Wisp/epoxy-tls)
- Core TLS strictness: `core/src/transport.rs` (ConfiguredCertificateChecks::Automatic); relay postfix/dovecot config: `cmdeploy/src/cmdeploy/postfix/{master,main}.cf.j2`, `dovecot/dovecot.conf.j2` (`ssl = required`)

Not verified here: I did not build slothfulchat or run its e2e (that needs clang +
wasm-pack and ~3 GB of free RAM for a release LTO build; it is the first task of the
spike). The Dovecot loopback-plaintext behaviour behind PR #1030 is also inferred, not
tested.
