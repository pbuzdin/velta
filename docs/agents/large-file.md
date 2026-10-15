# Large file via Lufi (#138) — agent notes

Attach menu → **Large file**. Tauri shell only (desktop + Android); hidden in
the PWA (no shell to tunnel through the account proxy, no CSP connect-src for
arbitrary Lufi hosts) and in local (p2p) chats.

## Flow

1. Pick (`plugin:dialog|open`; Android content:// → `resolve_content_uri`).
2. `lufi_open_file(path)` registers the file → `{handle, size, name}`;
   slices are read by handle only (`lufi_read_slice`, base64 of 750 000 B).
3. `lufi_config(server, proxy)` = `GET <server>/about/config` → `max_delay`,
   `delay_for_size`, `default_delay`, `max_file_size`,
   `force_burn_after_reading`, `stop_upload`, `need_authentication`.
4. Dialog: server URL (persisted `velta-lufi-server`), expiry
   (`lufiDelayChoices`: largest `delay_for_size` threshold ≤ size caps,
   else `max_delay`; 0 = unlimited → "Never"), "delete after first download".
5. `lufi_ws_open` → per slice `lufi_ws_send(frame)` → reply JSON. Progress
   modal, Cancel = AbortController → `{id, mod_token, cancel:true}` frame so
   the server drops the partial file.
6. Message text: `📦 name (size)\n<server>/r/<short>#<key>\nAvailable until …`.
   `{server, short, token, deleteUrl, expiresAt}` stored in localStorage
   `velta-lufi-files` keyed `<account>:<msgId>`; Message info shows it and
   "Delete from server" (`POST /d/<short>/<token>?_format=json` — that route
   skips Lufi's CSRF check).

## Wire compatibility (Lufi 0.07.x, upload.disroot.org runs 0.07.4)

- frame = `JSON(meta) + "XXMOJOXX" + JSON.stringify(sjcl.encrypt(key, btoa(slice)))`
  — the payload is a JSON *string* containing SJCL's JSON (double-encoded,
  lufi-down.js does `JSON.parse` then `sjcl.decrypt`).
- meta = `{total, part, size, name, type, delay, del_at_first_view, zipped:false, id, i:0}`;
  `id` is null on slice 0, then the `short` from the first reply.
- key = base64 of 32 random bytes (like `genRandomKey`), only in `#fragment`.
- SJCL defaults (AES-128-CCM, PBKDF2-SHA256 ×10 000, 64-bit tag). Velta passes
  one random salt per file (so `cachedPbkdf2` derives once, ~125 ms/slice in
  V8 instead of PBKDF2 per slice) and a fresh random IV per slice; both ride
  in each slice's JSON, so the download page is unaffected.
- Lufi's sjcl build has no `codec.bytes` — lufi.js converts via hex.

## Network (KEEP)

`lufi.rs` is a minimal RFC 6455 client (masked text frames out, pings
answered, fragments joined, 4 MB reply cap) over rustls + webpki-roots, TCP
via `link_preview_proxy(proxy)`: none → direct, `socks5`/`socks5h` → SOCKS5
with remote DNS (the DNS tunnel needs that), `http` → CONNECT. Anything else
(Shadowsocks, https proxy, garbage) is an Err. No direct fallback, ever. No
new crates: rustls/webpki-roots/socks are ureq's own.

## Verification

- `node --test tests/lufi.test.mjs` — mock Lufi server: multi-slice upload
  decrypted the lufi-down.js way, SJCL params, meta keys, cancel frame,
  refusals, expiry table, server normalization, link parsing, token store,
  SJCL hash pin, wiring.
- `cargo test --lib lufi` (src-tauri) — URL parsing, accept key (RFC 6455
  vector), frame codec at all length forms, fail-closed proxies, slice reads.
  `-- --ignored` adds a live upload+delete against upload.disroot.org.
- Full round trip through the Rust client (done 2026-10-15, random bytes,
  deleted right after): `cargo build --example lufi-pipe`, then a node script
  that runs `lufiUpload` with a transport writing frames to the pipe's stdin,
  downloads via `wss://<server>/download/<short>` (`{"part":n}` …
  `{"ended":true}`), `decryptSlice`s and compares sha256; also through a local
  SOCKS5 proxy (`socks5h://`), which saw only `CONNECT upload.disroot.org:443`
  by name. Never upload real user data when testing.

## Open / on-device

- Android: content:// picks are copied to app storage first (big files
  double disk use briefly); progress modal on a phone; DNS tunnel path.
- The renderer encrypts on the main thread between awaits (UI stays
  responsive per slice; a worker would be smoother for multi-GB files).
- Receiving side has no special card yet: the link opens in the in-app
  browser, the Lufi page decrypts.

# Part 2 — "Velta Drop (both online)" (formerly "Send directly")

Built-in webxdc (`app/webxdc/send-direct/` → `app/builtin/send-direct.xdc`,
AGENTS.md §5.4.2) over the realtime channel Velta's host now implements
(docs/agents/webxdc.md). Sender: Choose a file (`importFiles`) → OFFER
broadcast every 2.5 s + a status update (`Offering …` info line, lets late
openers see the offer). Receiver: Receive (enabled once a live OFFER is
heard) → REQ windows of 8 chunks, re-asked after 1.5 s → assembled bytes
must match the offer's SHA-256 → Save to chat / Download. Several
receivers can pull at once (chunks are broadcast, sender de-dupes bursts).

Verified: node tests (lossy two-receiver simulation, tamper → mismatch,
shim join/send/leave over the bridge, xdc freshness); a two-page Chromium
run of the built .xdc with a stub webxdc relay dropping 10 % of frames
(300 kB, SHA-256 match after Save to chat). NOT verified here: the real
core path (iroh gossip between two devices) — needs an on-device check.

Ceilings: both peers must have the app open; the sender holds the whole
file in memory (`importFiles` reads it fully), so this is for files that
fit in RAM; each chunk crosses JSON-RPC as a number array (~4× size).
