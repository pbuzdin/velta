# DNS tunnel link

Velta's optional DNS tunnel (Android and Windows apps; `velta-app/soar-tunnel`,
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
the link rebuilt from that tunnel (`tunnel_link {id}`, label included), with
Copy and Share buttons. Only share it with people you trust.

There is no https form: Velta has no verified app-link domain for it, and an
https link would put the server key in web server logs.
