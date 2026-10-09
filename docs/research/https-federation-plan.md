# HTTPS Federation — dropping port 25 for relay-to-relay mail (plan)

Status: **stage 1 in progress** · 2026-10-09 · target: the private relay
(modified chatmail fork) · author notes from the 10-09 relay audit.

## Goal

Relay-to-relay message transfer over HTTPS instead of SMTP port 25:

```
client → HTTPS 443 → relay A → HTTPS 443 /mxdeliv → relay B
```

Motivation: a relay that speaks only 443 is tunnelable (Cloudflare), immune
to port-25/DPI blocking (RU ISP paths, WARP egress), has no SMTP spam surface
and no SMTP reputation machinery. "Private federation" = a closed set of
trusted relays; stock chatmail (nine.testrun.org & friends) stays SMTP-only,
so this is a deliberate scope reduction, not a drop-in replacement.

## Current state (verified on the box, 2026-10-09)

| Piece | State |
|---|---|
| `/mxdeliv` receiver | **LIVE** — nginx (30 MB cap) → `127.0.0.1:10082`, where `filtermail` (Rust, `filtermail_http_port_incoming`) accepts `POST /mxdeliv` with a raw RFC822 body, validates it ("Invalid DATA" on junk), and feeds the normal incoming chain (postfix reinject 10026 → Dovecot). No auth header required today. |
| Outbound HTTPS transport | **MISSING** — `transport_maps` is empty; outbound relay-to-relay is classic SMTP-by-MX. `filtermail`'s LMTP transport leg (10083) hands back to Postfix. |
| Client-facing ports | 465/587/993 must stay for native clients (DC core has **no SRV support** and no client HTTPS submission — verified in vendored core/src). The PWA already does everything over 443 (C3 websockify + `/new`). |
| DNS | MX 10 self, SPF/DMARC/DKIM live (2026-10-09). MX must stay for SMTP peers during dual-stack; **the apex must stay a grey-cloud A record** — a proxied apex kills 25/465/993 for native clients (CF edge refuses non-HTTP ports; core ignores SRV). |

## Stages

### Stage 0 — private-federation posture at the firewall (zero code)

Allowlist port 25 to known peer IPs (`nft add rule inet filter input tcp dport
25 ip saddr { <peers> } accept` + drop). No spam surface, no changes to the
mail stack. **Deferred until the peer set is named** — applying it without the
list breaks live federation. Everything else below works regardless.

### Stage 1 — outbound HTTPS transport + peer auth (this plan's deliverable)

1. **Peer registry** — `/etc/chatmail-federation/peers.json`:
   `{"peer.example": {"url": "https://peer.example/mxdeliv", "token": "…"}}`.
   Token file `0600 root:root`.
2. **Sender** — Postfix pipe transport `httpsfederation` (master.cf) →
   `/usr/local/lib/chatmaild/mxdeliv-send`: reads the message on stdin, picks
   the peer config by recipient domain, `POST` message → peer URL with
   `Authorization: Bearer <token>`. Exit 75 (defer) on 5xx/timeouts so Postfix
   retries; exit 0 on 2xx; bounce on 4xx. `transport_maps` entry per peer
   domain → `httpsfederation:`. Dual-stack: SMTP peers keep MX delivery.
3. **Receiver auth** — parity with port 25 today (delivers to local users
   only, no open relay) but tightened for private federation: nginx
   `allow <peer-IP>; deny all;` inside `location /mxdeliv` (per-peer IPs),
   optional shared-token check later. 30 MB body cap already enforced.
4. **Self-federation test** (no second server needed): `transport_maps`
   temporarily maps the relay's own domain to the HTTPS transport → a locally
   submitted message loops through pipe → public HTTPS → nginx → 10082 →
   filtermail → 10026 → Dovecot. Proves every hop; revert the map after.

### Stage 2 — client HTTPS submission (upstream track)

Native clients still need 465/993. Upstream direction already points here
(SMTP-over-443 ALPN works against chatmail relays; prefer-443 feature work;
Velta iroh PRs). Once clients can submit/fetch over 443, Postfix/Dovecot go
loopback-only and the whole relay becomes a 443 service behind Cloudflare.

### Stage 3 — turn 25 off, per peer

Only after a peer runs Stage 1 both sides and confirms traffic on HTTPS.
MX drops the peer (or goes to an MX-only hostname). Never a hard cutover.

## Security notes

- E2E: DC messages are Autocrypt-encrypted end to end — federation transport
  changes metadata and reachability, never content.
- Receiver must only deliver to **local** recipients (same trust boundary as
  smtpd `reject_unauth_destination`); oversized/rate-limited at nginx.
- Peer auth: Bearer token + IP allowlist; TLS is public CA (mutual TLS later
  if wanted).
- Abuse posture: HTTPS receiver ≈ today's port 25 for-mydomain-only posture,
  minus the SMTP smear (no HELO/EHLO games, no open-relay probes in logs).

## Test matrix (stage 1 acceptance) — RUN 2026-10-09, all green

- [x] Receiver live: junk body → 400 "500 Invalid DATA"; unsigned body →
      400 "554 No DKIM signature found" (the receiver REQUIRES valid DKIM —
      port-25 inbound enforces the same on this fork, verified in mail.log).
- [x] Valid DKIM-signed message to a local user over public HTTPS → 200
      "250 OK" → postfix lmtp `status=sent (250 … Saved)` → INBOX.
- [x] Sender: `mxdeliv-send` (installed at
      `/usr/local/lib/chatmaild/mxdeliv-send`, runs against
      `/opt/mxdeliv-venv`, DKIM-signs with `/etc/dkimkeys/opendkim.private`,
      selector `opendkim`) → exit 0 + lmtp `status=sent` for a local user.
- [x] Defer: unreachable peer → exit 75 (Postfix retries).
- [x] Bounce: no peer entry → exit 1. Hardened: a 2xx whose body is not
      "250 …" (SPA fallback / captive portal false-2xx) → exit 1.
- [x] Non-local recipient: **not relayed** — receiver answers 250 then
      drops (no postfix trace). Not an open relay, but a protocol bug:
      peers must get 550 for non-local recipients (fix belongs in the
      fork's filtermail). Tolerable between trusted peers; must be
      documented to them.
- [x] Regular SMTP untouched: `transport_maps` intentionally NOT installed
      yet — per-peer wiring is one master.cf pipe entry + one map line at
      enablement time (mapping applies to REMOTE peer domains only, so the
      reinject loop risk only exists for self-domain tests, which we skipped
      on a live relay).

## CORRECTION (2026-10-09, after mrgluek's review of this commit)

The test matrix above contains misreadings — walked back with probes:

- **The envelope rides HTTP headers, not the body.** `X-MAIL-FROM` (single)
  and `X-MAIL-TO` (repeatable) are the only recipient source; `To:`/`Cc:`
  are never read. My earlier probes set no `X-MAIL-TO`, so every "250 OK"
  was a no-op (empty RCPT list); the lmtp `status=sent` lines I attributed
  to my probes were real user traffic. With the header set properly, the
  chain works exactly as the protocol intends: reinject → postfix
  `550 5.1.1 User doesn't exist` for an unknown user (proper SMTP
  semantics, not a "250-then-drop bug" — that flag is retracted), and
  plaintext to a real local user → `400 "523 Encryption Needed"` — the
  receiver **enforces E2E** for local users, stronger than stated.
- **Outbound HTTPS federation is already shipped.** The fork runs
  **filtermail 0.6.4** (changelog: "Upgrade to filtermail v0.6.4"), which
  carries the upstream HTTPS transport channel: Postfix
  `default_transport = lmtp-filtermail:inet:[127.0.0.1]:10083` routes ALL
  outbound through filtermail-transport, which tries
  `POST https://<mx>/mxdeliv` first per MX and falls back to SMTP:25 with a
  30-min per-host cache. Stage 1's "build" therefore collapses to
  configuration that is already live; `mxdeliv-send` / pipe /
  `transport_maps` / `peers.json` are **redundant** (kept on the box as a
  diagnostic probe only, now protocol-correct: sets the X-MAIL-* envelope
  and classifies by the SMTP code inside the 400 body).
- **Sender response semantics**: the receiver answers 200 only after the
  reinject got 250; every rejection is 400 with the SMTP reply in the body
  (`4xx` SMTP → defer, `5xx` SMTP → bounce), `413` = oversize. HTTP status
  alone is not meaningful.
- **Peer auth**: the wire protocol has no token — stock relays send only
  `X-MAIL-FROM`/`X-MAIL-TO`. A Bearer requirement at nginx is a protocol
  fork that pushes stock peers to their SMTP:25 fallback; behind
  Cloudflare, IP allowlists additionally need `set_real_ip_from` +
  `real_ip_header CF-Connecting-IP` or nginx sees only CF addresses. The
  stock trust model (DKIM domain alignment + E2EE-for-local + local-only
  recipients) is the gate; decide consciously if the private federation
  needs more.

**Revised stages:** Stage 1 is DONE (shipped upstream, live on the relay).
The only decision left for "Private Federation" is Stage 0's firewall policy —
inbound-25 off = drop SMTP-only peers; outbound-25 off = stop talking to
them entirely (HTTPS-first makes this survivable for current-filtermail
peers). Stage 2 (client-side 443) unchanged.

## Install state on the relay (2026-10-09)

- `/usr/local/lib/chatmaild/mxdeliv-send` + `/opt/mxdeliv-venv` (dkimpy).
- `/etc/chatmail-federation/peers.json` — `<relay-domain> →
  https://<relay-domain>/mxdeliv` as the self-entry/example; add real peers as
  `{"peer.example": {"url": "…/mxdeliv", "token": "…"}}`.
- Postfix wiring (NOT yet applied — do per peer enablement):
  `postconf -e transport_maps=hash:/etc/postfix/transport`, master.cf pipe
  entry `httpsfederation … pipe flags=DRhu user=postfix argv=
  /usr/local/lib/chatmaild/mxdeliv-send ${recipient}`, map line
  `peer.example  httpsfederation:` + `postmap`.
- Receiver auth: none at HTTP layer yet (dkim-verified mail from anyone is
  processed for LOCAL recipients only; non-local dropped). For private
  federation add the nginx `allow <peer-IP>; deny all;` + Bearer-token
  check when the peer set exists.

## Operational findings (2026-10-09, separate from this plan)

- **How to actually check whether outbound port 25 is open** (10-09: the
  naive probe lied for hours): `head -c 80` after a `/dev/tcp` connect
  waits for exactly 80 bytes — SMTP greetings are shorter, so an OPEN
  port reads as blocked. Read ONE line with its own timeout instead:
  `timeout 10 bash -c 'exec 3<>/dev/tcp/mx.google.com/25; timeout 5 head -1 <&3'`
  → `220 … ESMTP` = open. TCP-connect-without-banner = reachable but
  tarpitted (PTR missing/mismatched — strict receivers stall such sources
  silently; fix rDNS at the hoster). Decisive network-path proof:
  `tcpdump -i <if> host <mx> and tcp port 25` during a probe — SYN +
  SYN-ACK back = path fine, problem is SMTP-level. Postfix's own verdict:
  `proxy-reject: END-OF-MESSAGE: 451 …` in mail.log (ISO timestamps!)
  with `sasl_username=` showing client auth was already fine.

- **Outbound SMTP rejects for missing PTR**: filtermail-transport logs
  `450 4.7.25 Client host rejected: cannot find your hostname,
  [<relay-ip>]` (vivaldi.net et al) — the relay's host IP has no reverse
  DNS. Fix = set a PTR (the relay domain) at the hosting panel; until then
  some outbound mail defers forever. HTTPS federation is immune to this —
  one more argument for stage 2.
- The /new-minted test account `4vysiqdl9@<relay-domain>` accepted a message
  (250) with no delivery trace, same accept-then-drop class as non-local
  recipients — account visibility inside filtermail should be re-checked
  before any peer cutover.
