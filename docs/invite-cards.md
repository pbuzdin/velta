# Invite cards and native relay-invite signup

Velta turns its own invite links inside chat messages into action cards
(`app/js/invite-cards.js`), and every Velta build can now create an account
from a relay invite (`https://<relay>/i/<token>`).

## Recognized links (strict)

| Kind | Shape | Parser |
| --- | --- | --- |
| Proxy invite | `velta://ws?u=<wss url>&n=<name>&t=<token>` | `parseProxyInvite` → `parseWsLink` (ws-transport.js) + token payload |
| Relay invite | `https://<host>/i/<token>` | `parseRelayInviteLink` |
| DNS tunnel | `velta://tunnel…` (v1 query or v2) | `parseTunnelInvite` → `parseTunnelLink` (tunnel.js) |

Anything malformed is **not** a card and stays ordinary text:

* Relay: `https` only; DNS host with an alphabetic TLD (no IP, port, userinfo,
  `localhost`); token `[A-Za-z0-9_-]{8,128}` and not `claim`; no query,
  fragment or extra path; at most 300 characters.
* Proxy: everything `parseWsLink` enforces (u/n/t only, once each, `wss://`,
  no credentials, length caps). A token, when present, must be
  `base64url(payload).base64url(43-char HMAC)` with payload exactly
  `{"v":1,"i":str,"n"?:str,"e"?:int>0,"u"?:1..10000}` (UTF-8 JSON, no other
  keys). The HMAC is **not** verified client-side; the payload is shown for
  information only — the proxy checks the signature at the handshake.
* The message scan uses the same boundaries as `markdown.js` (`[^\s<]`,
  `trimLinkEnd`), so a card exists exactly when the text shows its chip.

## Rendering

* In the message text each valid invite URL becomes a token-free chip
  (`Relay invite: relay.example`, `Proxy invite: proxy.example.org`). A
  malformed `velta://` link stays escaped plain text.
* Below the text (`chat-view.js` → `inviteCardsHtml`), one card per message:
  * **Proxy card** — name (link `n`, else token `n`, else host), server,
    expiry (`e`) and device limit (`u`); buttons **Use proxy** and **Save**.
  * **Relay card** — relay host, "single use; expiry is checked when you
    join" (relay tokens are opaque, see *Server* below); **Create account**.
  * **Combined card** (relay + proxy in one message, e.g. Veltar's
    `/invite NAME`) — "Join <relay>: account + proxy"; **Join** saves and
    activates the proxy first, then creates the account through it.
  * **Tunnel card** — name and domain; **Set up tunnel** (the existing
    `acceptTunnelLink` flow with its confirmation and chooser).
  * Every card: "From <sender>" for incoming messages, **Show link**
    (reveals the raw link in a `<code>`, `aria-expanded`) and a copy button.
  * An expired proxy (or combined) invite shows an **Expired** badge, greyed
    text (still >= 9:1) and disabled action buttons; Show link / copy stay.
* Link previews never fetch relay invite URLs (the token is a bearer secret).

Nothing is applied without a tap, and every action goes through its usual
confirmation: **Use proxy** = `acceptWsLink` (confirm dialog, add + use);
**Save** = `saveWsLink` (native `ws_transport_add` with `activate:false`;
PWA: added to *WebSocket relays* with its token, active relay unchanged);
**Create account** asks first (the invite is single-use); **Join** shows one
combined confirmation (`joinWithWsLink`).

### Platforms

* **Android / Windows**: proxy via the WebSocket transport; the claim runs
  through it (below).
* **Desktop Linux/macOS**: no WebSocket transport — Use/Save report that, and
  Join creates the account directly (or through the profile's own proxy).
* **PWA**: Use = existing `acceptWsLinkPwa` (adds the relay with its token,
  switches, reloads). Join saves the proxy to the relay list, then runs the
  existing join flow (`createAccountFromRelayInvite`), which picks a working
  route (`ensureMailTunnelForLink`) and resumes after its reload.

## Native relay-invite signup

*Add account* (field or QR scan) and the onboarding relay field accept a relay
invite (`https://relay.example/i/<token>`, scheme optional).
`claimAndConfigure` then:

1. **Claim** — PWA: same-origin `fetch` as before. Native: the shell command
   `relay_invite_claim(host, token, proxy)` (lib.rs; the renderer is
   CORS-bound) does `GET https://<host>/i/claim?t=<token>` with ureq, through
   the profile's proxy (`proxy_url` when enabled — the WebSocket transport /
   DNS tunnel SOCKS port after `tunnel_reapply`), never falling back to a
   direct fetch. Host and token are re-validated in Rust. It returns
   `{status, body}`; credentials are never logged.
2. **Map the answer** — `relayClaimResult`: 200 → `{email, password}`;
   409 "already been used", 410 "expired", 403 "not valid", 400 "damaged",
   404 "doesn't accept invites", 503 "can't create accounts right now … the
   invite was not used" (the relay answers 503 before consuming a use),
   other → "error (N)".
3. **Configure** — native: `core.addAccountWithCredentials` (rpc-core):
   reuses an empty current profile or adds and selects a new one,
   `tunnel_reapply`, `add_transport`, `start_io`; on failure the previous
   profile is selected back. PWA: unchanged (`configureWithCredentials`).
   Claimed credentials are parked in `sessionStorage` for 30 min so a
   configure failure can retry without burning the invite.

## Server (no change made)

The relay's `invite.py` API used as-is: `GET /i/<token>` (HTML interstitial)
and `GET /i/claim?t=<token>` → `{"email","password"}` or `{"error"}` with
400/403/409/410/503. Native clients don't need CORS (shell-side fetch).

Proposed, optional server change for the relay card to show expiry / uses
before joining (not implemented; needs the operator's decision):

```python
# invite.py main(): read-only status, consumes nothing
if token == "status":
    invite = parse_qs(os.environ.get("QUERY_STRING", "")).get("t", [""])[0].strip()
    state, inv = invite_state(invite) if invite else ("invalid", None)
    return respond_json(200, {"state": state,
                              "expires": (inv or {}).get("expires") or None,
                              "uses": (inv or {}).get("uses", 1) if state == "valid" else 0},
                        no_store=True)
```

The client would call it from the card (shell-side on native) and grey the
card out when `state != "valid"`. Note that it reveals invite state to anyone
holding the token, which is already true of the interstitial page.

## Tests

`tests/invite-cards.test.mjs` (parsing incl. malformed/malicious links, card
HTML, chips, escaping, claim errors, action dispatch),
`tests/relay-invite.test.mjs`, and the Rust `relay_claim_tests` in lib.rs.
