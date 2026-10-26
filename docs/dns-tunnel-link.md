# DNS tunnel link

Velta's optional DNS tunnel (Android app only; `velta-app/soar-tunnel`,
`velta-app/src-tauri/src/tunnel.rs`, `app/js/tunnel.js`) is set up from one
link. Nothing changes until the user confirms it.

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
| `n` | no | Label shown in the confirmation | ≤ 64 characters, no control/bidi characters; kept on the device only |

The whole link is capped at 2048 characters. Unknown or repeated
parameters, a path, a fragment, or a bad value reject the link before
anything is shown. The Go library parses the link again (`ParseLink`) and
ignores `n`.

Example (placeholders only):

```
velta://tunnel?v=1&zone=t.example.org&key=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&n=Example
```

## Flow

1. The link arrives as an Android deep link (intent filter for scheme
   `velta`, host `tunnel` in `AndroidManifest.xml`), a scanned QR or a paste.
2. The page validates it (`parseTunnelLink`), then the shell previews it
   (`tunnel_preview`).
3. A confirmation shows the label, the domain and the warning that all chat
   traffic goes through the tunnel's server while the tunnel is in use. If a
   tunnel is already set up it offers **Replace** or **Cancel**.
4. Only **Enable**/**Replace** calls `tunnel_install`.

On desktop and in the browser app the tunnel is not available: the link
shows a message saying it works in the Android app, and nothing else.

## Sharing

DNS tunnel settings → **Share tunnel link** shows a QR code and the link
rebuilt from the installed config (`tunnel_link`), with Copy and Share
buttons. Only share it with people you trust.

There is no https form: Velta has no verified app-link domain for it, and an
https link would put the server key in web server logs.
