# relay-invite — invite-only account creation for a chatmail relay

Closes open signup on a chatmail deployment and gates account creation
behind single-use invite links (`https://<relay-domain>/i/<token>`).
Implements the R1/V2 slice of the Velta PWA plan
(`PLAN-PWA-WEBSOCKET.MD` in the velta repo).

Two files, deployed to the relay box:

| File | On the box | What it is |
|---|---|---|
| `invite.py` | `/usr/lib/cgi-bin/invite.py` (chmod +x) | fcgiwrap CGI: `GET /i/<token>` renders the interstitial; `GET /i/claim?t=<token>` atomically consumes an invite and answers `{"email","password"}` — same generator the stock `/new` uses |
| `invite-tool.py` | `/root/relay/invite-tool.py` (chmod +x) | root CLI: mint, list, revoke |

## Features

- **Single-use, atomic**: the claim takes an exclusive `flock` on the
  store, decrements `uses`, and records the minted address under
  `claimed` — two concurrent claims, one winner. Exhausted → `409`,
  revoked → `403`, expired → `410`.
- **Multi-use + expiry invites**: `add <uses> <days> [note]`; `expires`
  is checked at claim/visit time; `note` renders on the interstitial.
- **No credentials in URLs or logs**: the token is the only secret that
  rides a URL (it IS the invite link), and it is stored **hashed**
  (sha256) — the raw token exists only in the minted link. Credentials
  ride exactly one response, over TLS, marked `Cache-Control: no-store`.
- **Same-origin PWA hand-off**: the interstitial links
  `/app/index.html#/join?t=<token>`; the Velta PWA claims the invite and
  configures the profile automatically (see the velta repo,
  `createAccountFromRelayInvite`). The stock DC mobile flow keeps working
  via `dclogin:` links handed out by the operator.
- **Reputation-safe by construction**: recipients are minted by the relay's
  own user generator, so there is no open-relay surface and no
  registration endpoint left to abuse.

## Deploy

1. Copy the files to the paths above (target user `root`; the CGI must be
   readable+executable by the fcgiwrap user, typically `www-data`).
2. Store directory (the CGI needs group **write**):

   ```bash
   mkdir -p /var/lib/velta-invites
   chown root:www-data /var/lib/velta-invites
   chmod 750 /var/lib/velta-invites
   touch /var/lib/velta-invites/invites.json
   chown root:www-data /var/lib/velta-invites/invites.json
   chmod 660 /var/lib/velta-invites/invites.json
   ```

3. nginx, inside the HTTPS server block (fcgiwrap assumed at
   `/run/fcgiwrap.socket`):

   ```nginx
   location /i/ {
       add_header Access-Control-Allow-Origin $newmail_acao always;  # optional
       fastcgi_pass unix:/run/fcgiwrap.socket;
       include /etc/nginx/fastcgi_params;
       fastcgi_param SCRIPT_FILENAME /usr/lib/cgi-bin/invite.py;
       fastcgi_param PATH_INFO $uri;
   }
   ```

4. Close open signup so the invite is the only path:

   ```nginx
   location /new { default_type text/plain; return 403 "invite-only relay\n"; }
   location /cgi-bin/newemail.py { default_type text/plain; return 403 "invite-only relay\n"; }
   ```

   (`nginx -t && systemctl reload nginx`.)

## Usage

```bash
python3 /root/relay/invite-tool.py add 1 30 "friend"   # 1 use, 30 days
python3 /root/relay/invite-tool.py add 5 0 "family"    # 5 uses, no expiry
python3 /root/relay/invite-tool.py list
python3 /root/relay/invite-tool.py revoke <token-or-full-url>
```

`add` prints the full invite URL. Tokens are `secrets.token_urlsafe(18)`.

## E2E test recipe

```bash
URL=$(python3 /root/relay/invite-tool.py add 1 0 e2e); TOK=${URL##*/i/}
curl -s "https://<relay-domain>/i/$TOK" | grep -o "You're invited"       # interstitial
curl -s "https://<relay-domain>/i/claim?t=$TOK"                          # {"email","password"}
curl -s "https://<relay-domain>/i/claim?t=$TOK"                          # 409 used up
curl -s -o /dev/null -w '%{http_code}\n' https://<relay-domain>/new      # 403
```

## Troubleshooting (each of these cost us a debugging session)

- **All claims 502 after minting a new invite**: `invite-tool save()` uses
  `os.replace`, which silently flips the store to `root:root`. The CGI
  (www-data) then can't read/write it. The tool chowns the tmp file to the
  store directory's group (`0660`) — keep that chown if you edit.
- **502 on POST but GET works**: fcgiwrap on some setups 502s request
  *bodies*. That is why the claim is a GET with the token in the query
  string. Don't "fix" it back to POST.
- **`ModuleNotFoundError: chatmaild`**: the CGI's shebang must be the
  chatmail venv interpreter (`/usr/local/lib/chatmaild/venv/bin/python3`),
  not the system python — `chatmaild` and the `newemail` module live there.
- **404 JSON on `/i/claim`**: `PATH_INFO` didn't arrive — this routing is
  method+query based on purpose, keep it.
- **mail.log timestamps are ISO** (`2026-10-09T14:35:56`), not syslog
  `Oct  9` — grep accordingly when correlating claims with delivery.

## Security notes & limitations (v1, deliberate)

- The raw token rides URLs by design (it is the invite link itself);
  anyone holding the URL can consume a use. For high-value invites keep
  `uses=1` and short `days`.
- No AEAD claim tickets, no admin HTTP endpoints (CLI over ssh only), no
  rate limiting beyond single-use — fine at friends-and-family volume;
  revisit if the invite store ever outgrows a JSON file.
- The interstitial is served same-origin; the open-redirect/client-URL
  hardening from the plan only becomes relevant when the PWA lives on a
  different origin than the relay.
