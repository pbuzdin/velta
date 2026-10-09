# Client HTTPS mail API — plan for the Velta chatmail fork

Status: **proposal** · 2026-10-09 · target: pbuzdin/relay (chatmail fork)
· upstream direction reference: chatmail/relay `mxdeliv` (server↔server),
HTTPS-submission discussions (client↔server).

## Why

The Velta PWA (browser wasm core) can only talk to relays that run the Velta
C3 websocket bridge (`wss /tcp/993, /tcp/465, /dns/`), because browsers
cannot open raw TCP/ALPN. That pins every PWA user to relays running our
stack (the private relay) — stock relays like nine.testrun.org are
unreachable from the
browser even though they speak HTTPS federation (`/mxdeliv`) to each other.

A **client HTTPS mail API** fixes the class of problem: the relay exposes
account-scoped mail endpoints over plain HTTPS, so ANY browser (and any
native client that adopts it) can use ANY current chatmail relay with no
websocket bridge. It is also the prerequisite for the "no postfix" end
state — submission becomes an HTTP endpoint the queue engine serves, not a
public SMTP service.

## Non-goals

- No E2E changes: keys stay client-side (Autocrypt); the server never sees
  plaintext of user-to-user mail. The API carries opaque encrypted payloads.
- Not JMAP-complete. Minimum viable surface for a DC-core-shaped client.
- Does not replace IMAP/SMTP for existing native clients (they keep 465/993
  until Stage 2 core integration).

## Trust & threat model

- Client authenticates with the account's own credentials (chatmail
  accounts are credentials, no identities). `POST /api/v1/auth` mints a
  short-lived bearer token from `addr` + `mail_pw` (same secret the
  submission SASL path checks today via doveauth).
- All mail payloads arrive encrypted (chatmail E2EE posture): the receiver
  enforces it on `/mxdeliv` (`523 Encryption Needed`) and the client
  encrypts before `submit` — the server stays a courier.
- Abuse: per-account rate limits + size caps at the endpoint (parity with
  the 30 MB /mxdeliv cap), Message-ID idempotency to dedupe retries, same
  queue engine behind it as SMTP submission (one spam policy, two doors).
- CORS: same-origin by default; explicit `https:` origin allowlist for
  multi-relay PWAs (mirror of `ws_allowed_origins` — reuse the pattern and
  the config knob style).

## Endpoint surface (MVP)

| Method & path | Purpose | Backend |
|---|---|---|
| `POST /api/v1/auth` | creds → bearer token (TTL ~1 h, refresh re-auth) | doveauth (10084) |
| `POST /api/v1/submit` | RFC822 body (**unsigned**); server injects into the outgoing chain where the DKIM milter signs — client never holds keys | reinject 10025/10026 → queue → filtermail-transport (HTTPS-first) |
| `GET /api/v1/mail?since=<cursor>&limit=` | paged inbox: `{uid, ts, from, to, subject-hash, raw}` — raw RFC822; encrypted bodies stay opaque to the server | dovecot (lmtp store) via a reader daemon |
| `POST /api/v1/flags` | `{uid[], seen?, deleted?}` | doveadm/IMAP flags |
| `GET /api/v1/key/<addr>` | peer key lookup for pre-flight encryption (Autocrypt-equivalent) | key store |

Response semantics mirror `/mxdeliv` (the precedent): success only after
the operation is durable; rejections are `400` with the SMTP/IMAP-style
reason code in the body; senders classify on that code, never on HTTP
status.

## How the client consumes it — the honest part

The stock DC core speaks IMAP/SMTP; it cannot use this API today. Options:

1. **Upstream core transport** (`HttpTransport` beside the IMAP/SMTP one) —
   the real fix, upstream PR track, slowest. This plan's Stage 3.
2. **JS shim in the wasm glue** — intercept the socket layer, speak the API
   from JavaScript. Fork-only, fragile, but deliverable inside Velta.
3. **Interim (already available): websocket proxy to any relay** — the C3
   bridge becomes an allowlisted multi-relay byte pipe; the core keeps
   speaking IMAP/SMTP end-to-end TLS through it (see the multi-relay proxy
   notes in this repo's session notes / the private relay's deployment). Zero core
   changes, zero API needed — the bridge stays a dumb pipe and the user's
   TLS runs browser→target-relay, so the proxy reads nothing.

## Stages

- **Stage 0 — design review + upstream RFC.** mxdeliv shows upstream ships
  new delivery surfaces; a client submission/fetch API belongs in the same
  conversation. Get the endpoint shapes reviewed before building alone.
- **Stage 1 — submit-only server MVP** (auth + `/submit`). Unlocks
  browser-only *sending* to any relay account; fetch still rides IMAP.
  Small: auth shim over doveauth + injection into the existing queue.
- **Stage 2 — fetch/flags/key** (read daemon over the lmtp store). Full
  browser-only operation; the websocket bridge becomes unnecessary for
  API-capable relays.
- **Stage 3 — core integration** (upstream HttpTransport) or the JS shim
  as the interim consumer.

## Test/acceptance sketch

- auth: wrong password → 401; token TTL expiry → 401 + re-auth works.
- submit: signed-up E2E message accepted → 200 + queue id → delivered to a
  peer over `/mxdeliv`; oversize → 413-analog; bad recipient → 400 with
  5xx-class code; retry with same Message-ID → no duplicate.
- fetch: message saved to mailbox appears in `?since` paging exactly once;
  flags round-trip; deleted disappears from paging.
- abuse: per-account rate limit trips; oversize capped; CORS: cross-origin
  non-allowlisted origin rejected.

## Open questions

- Fetch backend: read the lmtp store directly (new daemon) vs. IMAP
  round-trip to dovecot (reuse the battle-tested path, adds an IMAP hop).
- Key discovery semantics (gossip vs. key directory) — depends on how DC
  core-side integration lands.
- Whether upstream prefers naming this "HTTPS submission" and folding it
  into the existing mxdeliv service instead of a sibling.
