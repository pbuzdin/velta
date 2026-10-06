# C3 relay deploy runbook — `websockify-c3` on a test relay

Turns the fork branch into a working relay-native setup for the Velta PWA,
then runs the wasm e2e against it (landing checklist §5, C3 box).

Branch: `pbuzdin/relay` `websockify-c3` (upstream websockify PR #1030 +
Velta hardening — see `cmdeploy/src/cmdeploy/websockify/README.md` on the
branch and spike log Days 22–23).

## 1. Deploy

On the deploy machine (cmdeploy targets a fresh Ubuntu VPS, same as any
chatmail deploy — see the relay repo's docs):

```sh
git clone -q git@github.com:pbuzdin/relay.git relay && cd relay
git switch websockify-c3
cd cmdeploy && pip install .
```

`chatmail.ini` — the new parameter drives every C3 gate:

```ini
[params]
mail_domain = <relay-domain>
# Browser origins allowed to open /tcp/ + /dns/ + /imap + /smtp and to mint
# accounts via /new (CORS). Comma-separated, https, no trailing slash.
ws_allowed_origins = https://<pwa-origin>
```

For the first smoke deploy the PWA origin can be the rig's
`http://127.0.0.1:<port>` — nginx matches the Origin string verbatim, so an
http origin works for local testing; production use is https-only.

```sh
cmdeploy init chatmail.ini
cmdeploy run <relay-host>
```

This installs nginx (with the `/tcp/`, `/dns/`, `/imap`, `/smtp`, `/new`
locations), the three websockify units (IMAPS 8143→993, submission 8587→465,
DNS bridge 8153) and the patched `newemail.py` CGI.

## 2. Verify by hand (no browser needed)

```sh
# DNS bridge answers a JSON IP array and closes:
websocat -1 wss://<relay-domain>/dns/<relay-domain>          # → ["203.0.113.7"]
# Origin gate: browser-like handshake from a disallowed origin is refused:
websocat -H 'Origin: https://evil.example' wss://<relay-domain>/tcp/<relay-domain>/993  # → 403
# Mail tunnels carry TLS (client-side): an openssl handshake through the tunnel:
websocat -H 'Origin: https://<pwa-origin>' wss://<relay-domain>/tcp/<relay-domain>/993 |
  openssl s_client -quiet -connect ignored:993 -servername <relay-domain> 2>/dev/null | head -1
  # → "* OK [CAPABILITY ...] ... Dovecot ready"
# CORS on account minting:
curl -si -X POST https://<relay-domain>/new -H 'Origin: https://<pwa-origin>' |
  grep -i access-control-allow-origin                        # → the origin echoed back
```

## 3. Wasm e2e against the relay-native endpoints

From the Velta repo (wrapper built via `apply-on-copy`, see
`packages/deltachat-wasm/README.md`; needs `npm i` in `scripts/`):

```sh
cd scripts && npm install
PACKAGE_ROOT=/tmp/velta-wasm-copy/packages/deltachat-wasm \
  RELAY_WS_URL=wss://<relay-domain> \
  CHATMAIL_NEW=https://<relay-domain>/new \
  node e2e-deltachat-wasm-network.mjs
```

This exercises exactly what the PWA will do: the wasm core resolves the
relay through `/dns/`, tunnels IMAPS/SMTPS through `/tcp/` with TLS inside
the wasm sandbox, and two throwaway accounts exchange an encrypted message.
`Ok: two accounts ...` = the C3 box on the landing checklist can tick.

## 4. PWA dist against the relay

`scripts/build-pwa.mjs --ws-proxy wss://<relay-domain> --out build/dist-pwa`
writes the relay endpoints into `pwa-config.js` (`window.VELTA_PWA`). The
dist boots on the wasm core with relay-native mail — no other change.

## Caveats (see the branch README for the full model)

- Self-signed test deploys (`tls_cert_mode = self`): the wasm core's rustls
  validates the certificate — implicit-TLS tunnels to a self-signed relay
  fail unless the cert is trusted by the client. Use a real cert (acmetool)
  or add the CA to the client for the smoke test.
- Account minting rate limits: `/new` keeps upstream's `limit_req` in
  self-signed mode; the CORS header does not bypass any limiter.
- The Mimosa push gate (flaky L3 project scan) — pushes of this branch must
  come from the user's terminal after removing `.mimosa/` from the clone.
