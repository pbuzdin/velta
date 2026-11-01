# SOCKS5 proxy links

Velta's native apps can send mail through a SOCKS5 proxy on the same device,
on the local network, or on the internet. Velta is a SOCKS5 **client**; it
does not provide or operate the proxy server. Several proxies can be saved,
with one or none active.

A proxy is added from a pasted link, a deep link, a scanned QR code, or a
chat card. Nothing changes until the user confirms it. Velta shares **v2**
(smaller QR codes) and accepts both forms.

## v2 (shared form)

```
velta://proxy/2/<HOST>/<PORT>[/U/<user base32>][/W/<password base32>][/N/<label base32>]
```

Everything after `velta://proxy/` is in the QR alphanumeric set
(`0-9 A-Z space $ % * + - . / :`), so the QR encoder packs that part at 5.5
bits a character instead of 8. The scheme and host stay lowercase because
Android matches intent-filter schemes and hosts case-sensitively. Parsers
accept either case.

| Part | Required | Meaning | Rules |
|------|----------|---------|-------|
| `2` | yes | Version | Any other number asks the user to update Velta |
| `<HOST>` | yes | Proxy hostname or IP | Public or LAN hostname, IPv4, or bare IPv6; normalized lowercase |
| `<PORT>` | yes | TCP port | `1..65535` |
| `U/` | no | Username | RFC 4648 base32 of UTF-8, no padding; at most 128 characters decoded |
| `W/` | no | Password | Same encoding and limit; requires a username |
| `N/` | no | Label | Same encoding; at most 64 characters decoded, no control/bidi-override characters |

Each optional part may appear at most once. Empty values, repeated parts,
trailing slashes, queries, fragments, invalid base32, and oversized values
are rejected. The whole link is capped at 2048 characters.

Example (placeholders only):

```
velta://proxy/2/PROXY.EXAMPLE.ORG/1080/N/J5TGM2LDMU
```

## v1 (query form)

```
velta://proxy?v=1&h=<host>&p=<port>[&u=<user>][&w=<password>][&n=<label>]
```

| Parameter | Required | Meaning |
|-----------|----------|---------|
| `v` | no (default `1`) | Link format version; only `1` is accepted |
| `h` | yes | Public/LAN hostname, IPv4, or IPv6 (brackets accepted) |
| `p` | yes | TCP port `1..65535` |
| `u` | no | Username, percent-encoded |
| `w` | no | Password, percent-encoded; requires `u` |
| `n` | no | Display label, percent-encoded |

Values use UTF-8 percent-encoding; `+` is accepted as a space. Unknown or
repeated parameters, a path, a fragment, and malformed values reject the
link before anything is applied.

## Confirmation and saved proxies

1. The page strictly parses the link and shows the proxy server and optional
   label. The confirmation warns that all chat traffic will use that server,
   that its operator can see which relays are contacted and when, and that
   links should only be accepted from someone trusted. Messages remain
   end-to-end encrypted.
2. **Add and use** saves and selects the proxy; **Add** only saves it. If the
   same host, port, and username are already saved, Velta offers the saved
   entry instead of adding a duplicate.
3. Drawer → **SOCKS5 proxy** lists saved proxies with **Use**/**Stop**,
   **Rename**, **Share**, and confirmed **Delete**. The add field also
   accepts a pasted link.
4. **Share** shows a QR code and the canonical v2 link, with Copy and Share.
   If credentials are included, the sheet warns that anyone with the link
   can use the proxy.

Credentials are stored in `proxies.json` in the app-private data directory
and are included in the profile's `proxy_url` while the proxy is active.
Treat both the saved entry and its share link as sensitive.

## How the proxy is applied

The shared keeper in `velta-app/src-tauri/src/proxy.rs` writes the selected
proxy into every profile and restarts its mail IO after a change. It only
replaces proxy settings it owns; a manually configured proxy is never
overwritten. Backup export and second-device transfer temporarily detach
keeper-owned proxy settings so device-local addresses and credentials are
not carried to another installation.

A selected SOCKS5 proxy and the WebSocket transport are mutually exclusive:
turning one on stops the other while leaving it saved. On upgrade, stale
`socks5://velta-tunnel:` profile URLs left by the archived DNS tunnel are
cleared because their old loopback listener no longer exists.

The browser app has no native proxy keeper, so these setup links require a
Velta native app. Android claims `velta://proxy` in its manifest; desktop
builds use the existing `velta` deep-link scheme.

There is no HTTPS form: an HTTPS setup URL could expose proxy credentials
in web-server logs, and Velta has no verified app-link domain for it.
