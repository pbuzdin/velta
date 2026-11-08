# Relay modules — invite-only signup and the WebSocket proxy

Two add-ons for a chatmail relay that is already serving mail. Each one
installs, configures, and uninstalls on its own. Accounts that already
exist stay either way.

Use `<relay-domain>` for the mail domain and `https://<pwa-origin>` for
the browser origin (no trailing slash). When the PWA is served by the
relay, the origin is `https://<relay-domain>`. Do not put a real private
hostname in the git tree. `relay.example.org` is the placeholder.

Copy `/etc/nginx/nginx.conf` aside before either install. Uninstall puts
that copy back.

A later `cmdeploy run` rewrites `/etc/nginx/nginx.conf` from the fork
template. The WebSocket locations are in that template. The invite
locations are not, so a redeploy drops them until they are added again.

## Invite-only relay

Closes `POST /new`. New addresses come from `https://<relay-domain>/i/<token>`.
Source: `scripts/relay-invite/`. Troubleshooting for the claim CGI is in
`scripts/relay-invite/README.md`.

| File | Installed path |
|---|---|
| `invite.py` | `/usr/lib/cgi-bin/invite.py` |
| `invite-tool.py` | `/root/relay/invite-tool.py` |
| invite store | `/var/lib/velta-invites/invites.json` |

`invite.py` starts with the chatmail venv
(`/usr/local/lib/chatmaild/venv/bin/python3`). System python cannot import
`chatmaild`. The claim is a GET. fcgiwrap on this stack returns 502 for a
request body.

### Install

On the relay, from a copy of `scripts/relay-invite/`:

```sh
install -m 755 invite.py /usr/lib/cgi-bin/invite.py
install -m 755 invite-tool.py /root/relay/invite-tool.py
mkdir -p /var/lib/velta-invites
chown root:www-data /var/lib/velta-invites
chmod 750 /var/lib/velta-invites
touch /var/lib/velta-invites/invites.json
chown root:www-data /var/lib/velta-invites/invites.json
chmod 660 /var/lib/velta-invites/invites.json
```

Inside the HTTPS `server` that already has `/new`, add:

```nginx
location /i/ {
    fastcgi_pass unix:/run/fcgiwrap.socket;
    include /etc/nginx/fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /usr/lib/cgi-bin/invite.py;
    fastcgi_param PATH_INFO $uri;
}

location /new { default_type text/plain; return 403 "invite-only relay\n"; }
location /cgi-bin/newemail.py { default_type text/plain; return 403 "invite-only relay\n"; }
```

The two `return 403` locations must replace the stock `/new` and
`/cgi-bin/newemail.py` blocks, not sit beside them.

```sh
nginx -t && systemctl reload nginx
```

### Configure

Mint, list, and revoke as root. `add` prints the URL once. The store keeps
only the sha256 of the token.

```sh
python3 /root/relay/invite-tool.py add 1 30 "friend"   # 1 use, 30 days
python3 /root/relay/invite-tool.py add 5 0 "family"    # 5 uses, no expiry
python3 /root/relay/invite-tool.py list
python3 /root/relay/invite-tool.py revoke <token-or-url>
```

`days` of `0` does not expire. The mail domain is read from
`/usr/local/lib/chatmaild/chatmail.ini` (`mail_domain`). The interstitial
sends the browser to `/app/index.html#/join?t=<token>` on this same host.
Native apps get a `dclogin:` link from the operator. They do not claim
`/i/<token>` themselves.

Check:

```sh
URL=$(python3 /root/relay/invite-tool.py add 1 0 check)
TOK=${URL##*/i/}
curl -s "https://<relay-domain>/i/$TOK" | grep -o "You're invited"
curl -s "https://<relay-domain>/i/claim?t=$TOK"          # {"email","password"}
curl -s -o /dev/null -w '%{http_code}\n' "https://<relay-domain>/i/claim?t=$TOK"  # 409
curl -s -o /dev/null -w '%{http_code}\n' "https://<relay-domain>/new"            # 403
```

A 502 on every claim after a mint means the store flipped to `root:root`.
`invite-tool.py` chowns the temp file to the store directory's group
before replace. Keep that.

### Uninstall

This opens signup again. Mailboxes created through invites stay.

```sh
# restore the nginx.conf copy from before the install, then:
nginx -t && systemctl reload nginx
rm -f /usr/lib/cgi-bin/invite.py /root/relay/invite-tool.py
```

Without a backup, delete the three locations above and put the stock
`/new` block back (public certificate, GET redirects browsers to
`dcaccount:`):

```nginx
location /new {
    add_header Access-Control-Allow-Origin $newmail_acao always;
    if ($request_method = GET) { return 301 dcaccount:https://<relay-domain>/new; }
    fastcgi_pass unix:/run/fcgiwrap.socket;
    include /etc/nginx/fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /usr/lib/cgi-bin/newemail.py;
}
location /cgi-bin/newemail.py {
    if ($request_method = GET) { return 301 dcaccount:https://<relay-domain>/new; }
    fastcgi_pass unix:/run/fcgiwrap.socket;
    include /etc/nginx/fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /usr/lib/cgi-bin/newemail.py;
}
```

`$newmail_acao` exists only while the WebSocket proxy module is installed.
Delete that `add_header` line when the proxy is not installed.

Delete the store only when the unused invites can go. This does not delete
mailboxes:

```sh
rm -rf /var/lib/velta-invites
```

## WebSocket proxy

Browser mail for the wasm core. The PWA connects to `wss://<relay-domain>`
and the relay dials IMAP and submission. Native clients keep using ports
993 and 465 directly. They do not need this module.

Source, in the relay fork: `cmdeploy/src/cmdeploy/websockify/` and the
matching locations in `cmdeploy/src/cmdeploy/nginx/nginx.conf.j2`. A full
`cmdeploy run` from that fork installs the units and the nginx locations.
The steps below are the same change on a relay that is already up.

| Public path | Loopback | What it reaches |
|---|---|---|
| `/imap` | `127.0.0.1:8143` websockify | this host's IMAPS (`localhost:993`) |
| `/smtp` | `127.0.0.1:8587` websockify | this host's submission (`localhost:465`) |
| `/dns/<host>` | `127.0.0.1:8153` `ws-dns-bridge.py` | JSON IP list. This relay's own name is `["127.0.0.1"]`. Any other name is its public addresses. |
| `/tcp/<ip>/993`, `/465`, `/443` | `127.0.0.1:8153` | that address. `443` is the autopick speed probe. Other ports are refused. |
| `POST /cm-new/<host>` | nginx → `https://<host>/new` | stock chatmail signup. The PWA worker sends this because those relays do not send a CORS header. |

`127.0.0.1` may be dialed. Other private, link-local, and reserved
addresses are refused. `/cm-new/` refuses an IP literal and refuses
`<relay-domain>` itself. A name that resolves to a private address is
still dialed by `/cm-new/`.

### Install

```sh
apt-get install websockify python3-websockets
install -d /usr/local/lib/websockify
install -m 755 ws-dns-bridge.py /usr/local/lib/websockify/ws-dns-bridge.py
python3 /usr/local/lib/websockify/ws-dns-bridge.py --check
```

`/etc/systemd/system/websockify-imap.service`:

```ini
[Unit]
Description=WebSocket proxy for IMAPS
After=network.target

[Service]
Type=simple
Restart=always
ExecStart=/usr/bin/websockify 127.0.0.1:8143 localhost:993
DynamicUser=true

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/websockify-submission.service`:

```ini
[Unit]
Description=WebSocket proxy for SMTP submission
After=network.target

[Service]
Type=simple
Restart=always
ExecStart=/usr/bin/websockify 127.0.0.1:8587 localhost:465
DynamicUser=true

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/websockify-dns.service` — the argument is the mail
domain, so this relay's own name stays on loopback:

```ini
[Unit]
Description=WebSocket DNS bridge for wasm mail clients
After=network.target

[Service]
Type=simple
Restart=always
ExecStart=/usr/local/lib/websockify/ws-dns-bridge.py <relay-domain>
DynamicUser=true

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload
systemctl enable --now websockify-imap websockify-submission websockify-dns
```

In the `http` block:

```nginx
map $http_origin $wsmail_origin_ok {
    default 0;
    "" 1;
    "https://<pwa-origin>" 1;
}
map $http_origin $newmail_acao {
    default "";
    "https://<pwa-origin>" "https://<pwa-origin>";
}
limit_conn_zone $binary_remote_addr zone=wsmail_conn:10m;
```

An empty `Origin` is allowed on `/imap`, `/smtp`, `/dns/`, and `/tcp/`.
Browsers always send one. `POST /cm-new/` rejects an empty origin itself.

In the HTTPS `server`, proxy `/imap` to `127.0.0.1:8143`, `/smtp` to
`127.0.0.1:8587`, and `/dns/` plus `/tcp/<ip>/{443,465,993}` to
`127.0.0.1:8153`. Each of those locations is:

```nginx
if ($wsmail_origin_ok = 0) { return 403; }
limit_conn wsmail_conn 10;          # leave this off /dns/ and /cm-new/
proxy_pass http://127.0.0.1:<port>;
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

`/tcp/` locations are regex (`location ~ ^/tcp/[^/]+/993$` and the same
for `465` and `443`). `/cm-new/` is the block in `nginx.conf.j2` under
`location ~ ^/cm-new/`. Do not write `{2,}` in that regex. nginx treats
`{` as the start of the block. The template uses `[a-z][a-z]+` for the TLD.

```sh
nginx -t && systemctl reload nginx
```

Reload nginx only after `websockify-dns` is listening on `8153`. A reload
while nothing is bound there makes browser mail fail DNS until the unit
is up.

### Configure

**Who may open a tunnel.** One origin per line in both maps, then
`nginx -t && systemctl reload nginx`. The same list belongs in
`chatmail.ini` so the next `cmdeploy run` renders it:

```ini
[params]
mail_domain = <relay-domain>
ws_allowed_origins = https://<pwa-origin>
```

Comma-separated, no spaces required, no trailing slash. Empty means no
browser origin is listed. Native clients with no `Origin` header still
connect. Editing `chatmail.ini` alone does not change a live hand-edited
nginx.

**Own domain.** The DNS unit's argument must be `<relay-domain>`.
Restart `websockify-dns` after changing it. Own-name answers stay
`["127.0.0.1"]` so this relay's mail does not hairpin through a public
address.

**PWA.** The page origin and this relay domain can differ. Put
`https://<pwa-origin>` in `ws_allowed_origins` (and the nginx maps).
Mail tunnels then open `wss://<relay-domain>` from that origin. New
account minting still needs `/cm-new/` on the PWA origin — serve the
PWA from this host, or reverse-proxy that path. Full recipe:
[`pwa-self-host.md`](pwa-self-host.md).

Quick deploy: clone branch `pwa-dist` (orphan snapshot of the static
tree, force-pushed, never merged) and upload it except `.git`. From
source, build with `node scripts/build-pwa.mjs --same-origin-proxy` and do
not pass `--ws-proxy` when the page is served by the relay (or when the
artifact must not carry a hostname). With `--same-origin-proxy`, an empty
`window.VELTA_PWA.wsProxyUrl` uses the page hostname at boot, or the domain
the visitor picks under WebSocket relays. Without it (static hosts such as
velta.cc) there is no proxy until an invite or the visitor adds one. Move
`app/.mimosa` and `app/js/.mimosa` out of the app tree before the build so hook state is not
precached. The wasm core must export `sqlite_export` (build refuses
otherwise) or profiles lose their database on reload. The service worker
is `velta-pwa-<12 hex>`; upload `sw.js` with the rest and check its
VERSION changed. Open pages show an update toast; reload once. A baked proxy URL is only for a PWA hosted on a different
origin, and that URL stays out of git.

Create-account on a relay that has no `/dns/` of its own stays on this
tunnel when `wss://<relay-domain>/dns/<that-host>` returns a non-empty
IP list. Autopick does that check against `example.com` first, then the
core probes its candidate pool.

### Uninstall

Browser accounts on this PWA stop. Native IMAP and submission on 993 and
465 stay. Mailboxes stay.

```sh
# restore the nginx.conf copy from before the install
# (drops /imap /smtp /dns/ /tcp/ /cm-new/ and the two maps)
nginx -t && systemctl reload nginx
systemctl disable --now websockify-imap websockify-submission websockify-dns
rm -f /etc/systemd/system/websockify-imap.service \
      /etc/systemd/system/websockify-submission.service \
      /etc/systemd/system/websockify-dns.service \
      /usr/local/lib/websockify/ws-dns-bridge.py
systemctl daemon-reload
```

`apt-get remove websockify python3-websockets` is optional. Nothing else
on a stock chatmail box depends on them.

Without a backup, delete those five locations and the `map` /
`limit_conn_zone` lines, then reload before stopping the units.

### Check

```sh
websocat -1 wss://<relay-domain>/dns/<relay-domain>     # ["127.0.0.1"]
websocat -1 wss://<relay-domain>/dns/example.com        # public IPs, not []
websocat -H 'Origin: https://evil.example' wss://<relay-domain>/dns/example.com  # 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Origin: https://<pwa-origin>' \
  https://<relay-domain>/cm-new/debian.org              # not 403 (debian answers 302)
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://<relay-domain>/cm-new/debian.org              # 403, no Origin
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Origin: https://<pwa-origin>' \
  https://<relay-domain>/cm-new/<relay-domain>          # 403, own domain
```

`/tcp/10.1.1.1/993` closes with WebSocket code 1008. `/tcp/127.0.0.1/993`
stays open and is this host's Dovecot. Chrome's "broken close frame" /
code 1005 line is the wasm client closing with no code. It is not a
failed dial.

## Both modules

Install the WebSocket proxy first when the PWA origin must be allowlisted,
then the invite module. Uninstall in either order. With both installed,
`POST /new` on this relay is 403 and a browser profile here needs an
invite. `POST /cm-new/<other-host>` still signs up on that other relay
through this tunnel.
