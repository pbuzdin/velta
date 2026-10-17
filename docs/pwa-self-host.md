# Host your own Velta PWA

The browser PWA is a static site plus a WebAssembly copy of the Chatmail
core. Serve the files over HTTPS. Mail leaves the tab through a WebSocket
proxy on a chatmail relay.

Native Windows / macOS / Android builds are a different product. This page
is only the wasm PWA.

## Quick start

A ready-to-serve tree lives on the `pwa-dist` branch: wasm-opt core,
brotli and gzip sidecars for the wasm, empty `wsProxyUrl` (visitors pick
a relay in the app). Clone it and upload the files:

```sh
git clone --depth 1 --branch pwa-dist --single-branch \
  https://github.com/pbuzdin/velta.git velta-pwa
```

Copy everything in `velta-pwa/` except `.git` to the HTTPS site root (or
`/app/` on a chatmail relay). Then:

1. Open the origin in a browser and **Add to Home Screen**.
2. In the app, **WebSocket relays** → add your chatmail domain.
3. On that relay, allowlist this PWA origin (`ws_allowed_origins` in
   [`relay-modules.md`](relay-modules.md)).

HTTPS is required (OPFS, the service worker, WebCrypto). `localhost` is
fine for a smoke test.

The branch is a snapshot and is force-pushed when the dist is rebuilt.
Re-clone (or `git fetch --depth 1 origin pwa-dist && git reset --hard
origin/pwa-dist`) rather than merging.

nginx that can serve the sidecars makes the first visit ~4.4 MB instead
of ~17 MB. Cloudflare / Netlify / similar CDNs compress on the fly, so
the sidecars are unused there and harmless.

```nginx
gzip_static on;
# brotli_static on;   # if ngx_brotli is installed
```

Building from source is the rest of this page.

## What you need

- Node.js 22+ (the dist builder)
- A wasm core with `sqlite_export` (CI artifact or a local `wasm-pack` build)
- An HTTPS static host (nginx, Caddy, Pages, any CDN). OPFS, the service
  worker, and WebCrypto need a secure context. `localhost` is fine for a
  smoke test.
- A chatmail relay with the WebSocket proxy from
  [`relay-modules.md`](relay-modules.md) if you want real mail. Without a
  proxy the PWA still boots and can restore an identity backup; it cannot
  talk IMAP/SMTP.

## 1. Get the wasm core

Do not build against the unpatched `core/` tree. Use a copy:

```sh
python3 tools/apply-wasm-core-patches.py apply-on-copy --dest /tmp/velta-wasm-copy
cd /tmp/velta-wasm-copy/packages/velta-wasm/rust
CC=clang wasm-pack build --target web --release --no-opt --out-dir ../wasm-dist -- --locked
```

Copy `velta_wasm.js` and `velta_wasm_bg.wasm` into
`build/wasm-dist/` in the Velta repo. Full local-build notes:
[`packages/velta-wasm/README.md`](../packages/velta-wasm/README.md).

Or download a `wasm-dist-no-opt` artifact from a **wasm-core (opt-in)**
GitHub Actions run (workflow_dispatch; it does not run on every push):

```sh
gh run download <run-id> -n wasm-dist-no-opt -D build/wasm-dist
```

Confirm the glue can save databases:

```sh
grep -c sqlite_export build/wasm-dist/velta_wasm.js   # must be > 0
```

Optimize before a public deploy (~28 MB → ~17 MB):

```sh
npm i --prefix tools/binaryen binaryen
node tools/binaryen/node_modules/binaryen/bin/wasm-opt -Os \
  build/wasm-dist/velta_wasm_bg.wasm -o build/wasm-dist/velta_wasm_bg.wasm
```

## 2. Build the dist

```sh
node scripts/build-pwa.mjs
node scripts/verify-pwa-dist.mjs
```

Output is `build/dist-pwa/`. Do **not** pass `--ws-proxy` if the PWA origin
and the relay domain are different, or if you do not want a relay hostname
baked into the artifact. An empty `wsProxyUrl` lets each visitor pick a
relay in **WebSocket relays**. `--ws-proxy wss://relay.example.org` is only
for a dist that should open that one tunnel on first boot.

Move `app/.mimosa` and `app/js/.mimosa` out of the tree before the build if
those directories exist, or they end up in the precache.

`verify-pwa-dist.mjs` opens a real browser and runs 10 checks (wasm boot,
OPFS snapshot, service worker, identity-backup round-trip).

## 3. Serve it

Upload the **whole** `build/dist-pwa/` tree, including `sw.js` and `wasm/`.
A missing `sw.js` leaves visitors on the previous cache forever.

Example nginx site. Replace `/var/www/velta-pwa` and `pwa.example.org`:

```nginx
server {
    listen 443 ssl http2;
    server_name pwa.example.org;
    root /var/www/velta-pwa;
    charset utf-8;
    charset_types text/css text/javascript application/javascript text/plain;

    types {
        application/wasm wasm;
        application/manifest+json webmanifest;
    }

    gzip_static on;
    # brotli_static on;   # if ngx_brotli is installed

    location = /sw.js {
        add_header Cache-Control "no-cache";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

The dist already ships `wasm/velta_wasm_bg.wasm.br` and `.gz`.
`gzip_static` / `brotli_static` pick those up. The service worker still
fetches the raw `.wasm` (the browser decodes `Content-Encoding`); it
does not precache the sidecars.

Add to Home Screen from the HTTPS origin. The service worker precaches the
shell. A new deploy must change `sw.js`'s `VERSION` (the builder hashes the
files, so any content change does that). Open tabs show "Velta was updated"
and take the new files after one reload.

## PWA on domain A, WebSocket proxy on domain B

Yes. That split is the intended setup.

| Piece | Where it lives |
|---|---|
| HTML / JS / wasm / service worker | `https://pwa.example.org` (A) |
| Mail tunnel `wss://…/dns/…` and `wss://…/tcp/…/{443,465,993}` | `wss://relay.example.org` (B) |

The browser sends `Origin: https://pwa.example.org` on every WebSocket
handshake. B must allow that origin:

```ini
# on the relay, chatmail.ini — then cmdeploy, or the same strings in nginx
[params]
mail_domain = relay.example.org
ws_allowed_origins = https://pwa.example.org
```

Comma-separated, https, no trailing slash. Several PWA origins can share
one relay. Native Delta Chat / Velta apps send no `Origin` and still use
993/465 directly; they do not need this list.

On the PWA, add `relay.example.org` under **WebSocket relays** (or bake
`--ws-proxy wss://relay.example.org` if this dist should only ever use B).
The dist CSP already allows `https:` and `wss:`.

Install the proxy on B with [`relay-modules.md`](relay-modules.md). Verify:

```sh
websocat -H 'Origin: https://pwa.example.org' \
  wss://relay.example.org/dns/relay.example.org
# → ["127.0.0.1"]
websocat -H 'Origin: https://evil.example' \
  wss://relay.example.org/dns/relay.example.org
# → 403
```

### What still has to be same-origin

**Mail I/O** (IMAP/SMTP through the tunnel) is origin-A → websocket-B.
Identity restore and an already-created address work with nothing else.

**New-account minting** (`POST /new`) is different. Stock chatmail sends no
CORS header, so the wasm worker rewrites that POST to
`https://<pwa-origin>/cm-new/<relay-host>`. A static host on A has no such
path unless you add it. Practical options:

1. Serve the PWA from the relay (`https://relay.example.org/app/`). Then
   `/cm-new/` is already on that host. Simplest.
2. Keep the PWA on A and reverse-proxy `/cm-new/` on A the same way the
   relay module does (see `location ~ ^/cm-new/` in
   [`relay-modules.md`](relay-modules.md)).
3. Skip in-tab signup: restore an identity backup, or create the address
   out of band and type the credentials.

Invite links `https://relay.example.org/i/<token>` currently hand off to a
same-origin `/app/` URL. If the PWA lives on A, point the interstitial at
`https://pwa.example.org/#/join?t=<token>` instead.

## What the wasm PWA does not do

- Local chat (iroh), the Android DNS tunnel, and UnifiedPush.
- More than one tab on the same origin: the wasm core takes a Web Lock.
- A crash can drop the last few seconds until the next OPFS snapshot
  (login, identity restore, hide-tab, periodic).
- Profiles created on dists from before commit `643ee36` never saved
  `dc.db`. Recreate or identity-restore those once.

## Updates

Re-clone `pwa-dist` (or rebuild from source), then upload the whole tree.
Confirm the served `sw.js` `VERSION` line changed. Clients pick it up on
the next load or when the page comes to the foreground.
