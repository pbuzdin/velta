# DNS tunnel link

Velta's optional DNS tunnel (Android and Windows apps; `velta-app/soar-tunnel`,
`velta-app/src-tauri/src/tunnel.rs`, `app/js/tunnel.js`) is set up from one
link. Nothing changes until the user confirms it.

Two forms are accepted, forever. Velta shares **v2** (smaller QR code);
**v1** stays valid for links already handed out.

### v2 (shared since 2026-10)

```
velta://tunnel/2/<ZONE>/<KEY>[/R/<resolvers>][/C/<canaries>][/N/<label>]
```

Everything after `velta://tunnel/` is in the QR alphanumeric set
(`0-9 A-Z space $ % * + - . / :`), so the QR encoder (app/js/qr-encode.js,
optimal segmentation) packs it at 5.5 bits a character instead of 8: a
byte segment for `velta://tunnel/`, an alphanumeric segment for the rest.
The scheme and host stay lowercase on purpose: Android matches
intent-filter schemes and hosts case-sensitively, and the existing
`velta`/`tunnel` filter keeps routing v2 links. Parsers accept any case.

| Part | Required | Meaning | Rules |
|------|----------|---------|-------|
| `2` | yes | Version | Any other number asks the user to update Velta |
| `<ZONE>` | yes | Tunnel zone, written uppercase | DNS is case-insensitive; parsed lowercased, same rules as v1 `zone` |
| `<KEY>` | yes | Server Ed25519 key | RFC 4648 base32, no padding, uppercase on output: exactly 52 chars, zero trailing bits |
| `R/` | no | Extra resolvers | `+`-separated; `ip` or `ip*port`, IPv6 without brackets (`2001:DB8::1*853`) |
| `C/` | no | Canaries | `+`-separated `HOST*port` |
| `N/` | no | Label | base32 of the UTF-8 label (same limits as v1 `n`) |

Each of `R`, `C`, `N` at most once; no empty values, trailing slash, query
or fragment. Example (placeholders only):

```
velta://tunnel/2/T.EXAMPLE.ORG/AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPQ/N/IV4GC3LQNRSQ
```

The page parses either form, then hands the shell the validated values as a
v1 link (`buildTunnelLinkV1`), so any build of the Go library works; Go's
`ParseLink` also understands v2 (`soar-tunnel/tunnel/link_v2.go`).

### v1

```
velta://tunnel?v=1&zone=<tunnel domain>&key=<server key>[&r=<resolvers>][&c=<canaries>][&n=<label>]
```

| Param | Required | Meaning | Rules |
|-------|----------|---------|-------|
| `v` | no (default `1`) | Link format version | Only `1`; anything else asks the user to update Velta |
| `zone` | yes | DNS zone delegated to the tunnel server | Lowercase LDH labels, ≥ 2 labels, ≤ 200 chars, trailing dot dropped |
| `key` | yes | Server Ed25519 public key | Base64 (standard or URL-safe, padding optional) of exactly 32 bytes; share links use URL-safe, unpadded |
| `r` | no | Extra resolvers, added to the built-in list | Comma list, ≤ 64, IP literals only: `ip`, `ip:port`, `[ipv6]:port` |
| `c` | no | Canary hosts (replace the defaults) | Comma list, ≤ 16, `host:port` |
| `n` | no | Label shown in the confirmation and the saved-tunnel list | ≤ 64 characters, no control/bidi characters; editable (Rename) |

The whole link is capped at 2048 characters. Unknown or repeated
parameters, a path, a fragment, or a bad value reject the link before
anything is shown. The Go library parses the link again (`ParseLink`) and
ignores `n`.

Example (placeholders only):

```
velta://tunnel?v=1&zone=t.example.org&key=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&n=Example
```

## Flow

1. The link arrives as a deep link (Android: intent filter for scheme
   `velta`, host `tunnel` in `AndroidManifest.xml`; Windows: the `velta`
   URI scheme registered by tauri-plugin-deep-link, forwarded to the running
   instance by single-instance), a scanned QR or a paste.
2. The page validates it (`parseTunnelLink`), then the shell previews it
   (`tunnel_preview`).
3. A confirmation shows the label, the domain and the warning that all chat
   traffic goes through the tunnel's server while the tunnel is in use, and
   offers **Add and use** (saves it and switches to it; the tunnel in use
   stays saved), **Add** (saves it only) or **Cancel**.
4. If the same tunnel (same zone and key, any base64 flavour) is already
   saved, nothing is added: the dialog only offers to use the saved one
   (`tunnel_select`), or says it is already in use.
5. Only **Add and use**/**Add** call `tunnel_install` (`activate` true/false).

## Saved tunnels

Several tunnels can be saved; one or none is in use. The shell keeps them in
`tunnels.json` in the app's private data dir (`tunnel_store.rs`): per tunnel
`id`, `label`, `zone`, `key`, `resolvers`, `canaries`, `mode`, `added` (unix
seconds), plus the shared local SOCKS port and credentials, so switching
tunnels keeps every profile's `proxy_url`. Keys are stored as before (the
app-private data dir); `tunnel_list` never returns them.

DNS tunnel settings → **Saved tunnels**: **Use**/**Stop**, **Rename**,
**Share** (QR + link) and **Delete** (confirmed; deleting the tunnel in use
stops it and mail connects directly). Mode and diagnostics apply to the
tunnel in use.

Upgrade: on first start the old single-tunnel `tunnel.json` becomes the
list's only, active entry (same port and credentials), and the page moves the
label it kept in local storage onto it; `tunnel.json` is deleted only after
`tunnels.json` is written.

On macOS, Linux and in the browser app the tunnel is not available: the
shell's `tunnel_status` reports `unsupported: true` and the link only shows
a message that it works in the Velta app for Android or Windows.

## Sharing

DNS tunnel settings → a saved tunnel's **Share** button shows a QR code and
the v2 link rebuilt from that tunnel (`tunnel_link {id}`, label included), with
Copy and Share buttons. Only share it with people you trust.

There is no https form: Velta has no verified app-link domain for it, and an
https link would put the server key in web server logs.
