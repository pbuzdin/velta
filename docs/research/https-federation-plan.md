# HTTPS Federation — dropping port 25 for relay-to-relay mail (plan)

Status: **stage 1 in progress** · 2026-10-09 · target: relay.example.org (modified
chatmail fork) · author notes from the 10-09 relay audit.

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
   temporarily maps `relay.example.org` itself to the HTTPS transport → a locally
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

## Test matrix (stage 1 acceptance)

- [x] Receiver live: `POST /mxdeliv` junk body → 500 Invalid DATA (parses RFC822).
- [ ] Valid message to a local user over public HTTPS → 2xx → message lands
      in the user's Dovecot mailbox (doveadm/log evidence).
- [ ] Loop test: locally submitted mail to a local user forced through the
      HTTPS transport arrives at the mailbox (proves pipe → script → nginx →
      10082 → reinject → LDA).
- [ ] Auth: peer entry with wrong token → non-2xx → sender defers (exit 75),
      nothing delivered.
- [ ] Non-local recipient → receiver rejects (no relay-for-others).
- [ ] Regular SMTP delivery for non-mapped domains unchanged after the
      transport_maps addition.
