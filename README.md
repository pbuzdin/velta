# Velta

A cross-platform **Delta Chat** client built as a single PWA-ish web app wrapped by **Tauri 2**.

## What it is

Velta shares one web frontend (`app/`) between:

- **Windows desktop** — a Tauri 2 app that bundles `deltachat-rpc-server.exe` as a sidecar.
- **Android mobile** — the same Tauri 2 app, but the Delta Chat core runs in-process inside the APK. A foreground service keeps sync (and notifications) running after the app is backgrounded.
- **Browser/PWA** — the same frontend can be served statically and connects to a local `velta-core-service` over loopback WebSocket/HTTP, or falls back to a mock core for demo purposes. The PWA's target deployment is a **remote core service over WSS/TLS** — the loopback bridge remains the local/dev path. If the loopback connection drops mid-session (service restart), the app reconnects automatically — backoff up to 15 s — and refreshes the chat list; no reload needed.

The UI is plain HTML/CSS/ES modules (no bundler). The backend is the upstream [Delta Chat core](https://github.com/chatmail/core) at version `2.61.0`.

## Screenshots

Captured from the responsive PWA running in demo mode (mock core), dark theme.

|                | Mobile | Desktop |
|:--------------:|:------:|:-------:|
| **Chat list**  | ![Mobile chat list](screenshots/mobile-chat-list.png) | ![Desktop chat list](screenshots/desktop-chat-list.png) |
| **Chat opened** | ![Mobile chat](screenshots/mobile-chat.png) | ![Desktop chat](screenshots/desktop-chat.png) |

## Functions

<details>
<summary>Local chat (beta)</summary>

Velta also ships a second, fully serverless transport: 1:1 end-to-end-encrypted
chat between paired devices on the same network (iroh QUIC, no relay, no
account). Devices discover each other via LAN beacons and pair in one of two
ways:

- **Invite QR / pasted code** — the ticket carries a one-time pairing token;
  presenting it is the out-of-band proof and pairing completes immediately.
- **Nearby tap** — sends a pairing request that the other device must
  explicitly approve in a dialog. Beacons carry names and addresses only,
  never the pairing token, so a LAN listener cannot pair by listening.

Paired devices exchange end-to-end-encrypted messages; messages to offline
peers are queued and flushed on reconnect. Engine: `velta-app/src-tauri/src/p2p.rs`;
UI: `app/js/p2p.js`. A headless terminal hub for debugging lives in
`velta-app/src-tauri/src/bin/p2p-hub.rs`.

Local chat is **disabled by default**. Switch it on/off in the drawer
("Local chat: on/off"): when off, the engine never starts (no endpoint
socket, no LAN beacons) and the card and drawer rows disappear. The
preference persists across restarts. On first run the welcome screen offers
"Enter local chat…" — it enables local chat and skips relay setup; enabling
local chat again later brings the setup screen back.

**Local chats look like regular chats.** Each paired peer appears in the chat
list and opens in the standard chat view (adapter: `app/js/local-chat.js`
wraps the core, so the virtualized list, composer, drafts and read-tick
rendering all work unchanged). Text and **media files** (images, video, audio,
any file up to 256 MB) are supported: files transfer as base64-chunked frames
over the same encrypted session, land in `p2p-blobs/<peer>/` under the
accounts directory and render through the regular media pipeline. Peer names
arrive only from pairing. The hub — device identity, invite QR, add contact,
nearby-device pairing — is a collapsible card pinned above the chat list
while local chat is on; peers must be online to receive media (text queues
offline). Voice messages are not offered in local chats (the attach menu hides
the item) and the audio-call button is hidden there — the P2P engine carries
no call signaling.

**Transfer and queue states are surfaced in the UI.** An outbound file shows a
progress bar fed by `file-progress` events (2% steps); a completed transfer
swaps the bar for the file card, and a session death mid-transfer marks the
message failed with a Retry button (re-sends the stored copy from byte zero —
there is no resume; the receiving side simply discards bad partials). Media
picked while the peer is offline parks in a queue chip at the right edge of
the composer (`#lc-queue-chip` → popup with per-item send-now/remove); the
queue auto-flushes, oldest first, on the peer's next `presence` online event.
Offline texts are queued inside the engine and show a pending clock in the
bubble: `p2p_send` returns `{id, queued}`, a reconnect flush emits a
`msg-state` event to upgrade the clock to ticks, and the peer's ack completes
the read state. A text whose send fails outright renders a Retry button too
(resendMessage re-sends the same text and quote as a fresh message; the
failed bubble is restored if the engine still rejects it). Chat names carry a
green wifi badge instead of the relay chats' open lock (the transport is
QUIC/TLS with pairing-pinned identities).

**Interface scale and theme live in the drawer.** Velta pins the WebView's
`textZoom` to 100 (system font scale otherwise inflates text out of its
px-sized boxes — broken layouts on devices set to the largest scaling
factor) and instead offers coherent, in-app scaling: a drawer spoiler with
Small / Normal / Large applied as a zoom on `<html>` before first paint.
The theme spoiler adds **Auto**, which follows the system's
`prefers-color-scheme` live (including the status-bar tint); it is the
default for fresh installs.

</details>

<details>
<summary>Audio calls (beta)</summary>

Single chats have an audio-call button in the chat header (core 2.60+).
Calls are end-to-end encrypted like everything else: the core carries the
call signaling — the offer and answer SDP ride in encrypted messages — and
hands the app the relay's STUN/TURN servers, while the audio itself flows
over a WebRTC peer connection inside the app's WebView.

- The call button appears in single chats only; group calls are not offered yet.
- Desktop (WebView2) grants the microphone through a launch argument; on
  Android the app asks for the record-audio permission on the first call.
- Missed, declined and ended calls appear in the chat, and calls ring only
  while the app is open — a backgrounded app shows the call as missed.

</details>

<details>
<summary>Pinned messages</summary>

Any message in a group or private chat can be pinned from the message context
menu (**Pin** / **Unpin**). The newest pinned message shows in a strip between
the chat header and the history — tapping it scrolls to the message. Pins sync
through the core's pinned-messages API (core 2.59+), so they work across
devices.

</details>

<details>
<summary>Search in chat</summary>

The chat header's magnifier opens a search over the **full history** — not
just loaded messages — backed by the core's fulltext index (group chats
included). Results list sender and text; tapping one jumps to the message.
Local (nearby) chats are searched within their loaded history only.

</details>

<details>
<summary>Shared contacts (vCards)</summary>

When someone sends a **person contact** into a chat (a `.vcf` vCard attachment),
Velta renders it as a compact contact card — avatar, display name and email
address — styled like the invite cards. Tapping the card imports the contact
(the vCard carries the contact's public key, which is the point of contact
gossip) and opens the direct-message chat. Re-sharing a received contact is the
message context menu's **Forward**. This core generation has no contact QR
codes — SecureJoin QRs exist only for the own profile and for groups — so the
vCard is the canonical shareable form.

</details>

<details>
<summary>Second-device setup (backup transfer)</summary>

The drawer's **Add a second device…** moves a profile between devices over the
LAN using the core's backup transfer:

- **Old device** shows a QR (its `provide_backup` offer, rendered as the
  design card with the Velta logo) and waits.
- **New device** taps **Receive a profile on this device…**, scans or pastes
  the code (`DCBACKUP2:…`, camera scan everywhere — native `BarcodeDetector`
  where the platform provides it, a built-in decoder fallback where it
  doesn't), and a fresh account is created and filled
  from the transfer — progress is reported live, and the other device stays
  signed in.

The **Welcome to Velta** splash (full-screen, with the same choices: create a
new profile on a relay — type the address or scan its QR — **add as second
device** via a `dcbackup:` code, or **restore from a backup** file) is shown
only while there is no configured profile. Returning users with at least one
account boot straight into the app.

</details>

<details>
<summary>Multi-relay accounts</summary>

One profile can be reachable on **several chatmail relays** at once — what
Delta Chat desktop 2.47+ calls "Relays". Messages are received on all of them;
sending always goes through the **primary** relay. Pick which one sends under
**Relays of this profile…** → **"Use for sending"** on any relay (messages
currently waiting to be sent are dropped, since they carry the old sender
address; the change syncs to your other devices). The status bar shows one
segment per relay, each colored by that relay's own status, with the sending
animation on the sending relay's segment only.

- **Add relay** — paste a `dcaccount:`/`dclogin:` invite code or just the relay's domain (`nine.testrun.org`); the core
  configures it as a second transport (progress modal during setup).
- **Use for sending** — makes that relay the primary (sending) transport.
- **Remove relay** — immediate removal (core 2.60.0): the relay stops being
  used right away and your contacts are informed automatically, but messages
  still on their way to the old address may arrive for a short while. Your
  last relay cannot be removed — the core re-elects a sending relay if
  needed.

The thin status line above the chat list reflects the relay connection:
green connected, yellow connecting/retrying, red unreachable (after a 45 s
grace), blue for demo or local-chat-only mode; animated dashes while a
message is on its way to the relay. Hovering the line (or pulling down at
the top of the chat list on mobile) reveals a detail bar overlaying the
list with one row per relay — status and quota usage — fed by the core's
connectivity page.

</details>

<details>
<summary>Deep links: formats and invite cards</summary>

Velta can open invite and account-setup links directly instead of making the user copy-paste them.

### Supported link formats

| Platform | Link type | What happens |
|---|---|---|
| Android | `https://i.delta.chat/#FINGERPRINT&v=3&…` (or a registered mirror domain, e.g. `https://i.gluek.info/#…`) | Intercepted by the Android intent filters and processed in-app. |
| Android / PWA | `https://deltachat.id/<name>` (username-service short link) | Expanded to the full invite URL in-app (shell-side fetch, cached) and rendered as an invite card. |
| Android / PWA | `openpgp4fpr:…` | SecureJoin/verification QR text. On Android the OS now offers Velta as a handler (registered intent-filter scheme). |
| Android / PWA | `dcaccount:https://nine.testrun.org/new` | Opens a chooser: add the relay to the current profile, or create a new chatmail account. Velta is registered for the raw `dcaccount:` scheme on Android (system chooser if other chat apps also handle it). |
| Android | `dclogin:…` | Chooser: add the (existing) relay account to the current profile. |
| Android | `DCBACKUP2:…` (second-device code) | Opens Velta's "Receive a profile" transfer flow directly. |
| Desktop (Windows/Linux) | `velta://invite?url=<encoded i.delta.chat URL>` | Opens Velta and joins the 1:1 or group chat. |
| Desktop (Windows/Linux) | `velta://account?url=<encoded dcaccount URL>` | Opens Velta and offers the relay/new-profile chooser. |

### Invite link mirrors and invite cards

An invite link's payload lives in the URL fragment (`#FINGERPRINT&v=3&…`) and is never
sent to a server — the host is decorative. Velta therefore accepts any **registered
mirror domain** and normalizes the link onto the canonical `i.delta.chat` form before
handing it to the core (which only parses that scheme).

- **Registry** — built-in hosts (`i.delta.chat`, `i.gluek.info`) plus user-added ones,
  managed in the drawer under *Settings → Invite link domains* (stored in
  `localStorage["velta-invite-hosts"]`, logic in `app/js/invites.js`).
- **OS-level interception is compile-time** — Android intent filters live in
  `AndroidManifest.xml` and can only be changed by adding the domain there and
  rebuilding. The runtime registry covers everything inside Velta: OS deep links
  (already routed to the app), links tapped in chat messages, and pasted links.
- **Invite cards** — an invite link inside a message renders as a card instead of a raw
  URL: the main part reads *"Pavel invited you to a Chat RU group"* or *"Chat with
  Pavel"* (parsed from the link's own `n=`/`g=`/`a=` params) and asks for confirmation
  before joining; a copy icon on the right copies the original link.

</details>

<details>
<summary>Deep links on Windows: velta:// scheme, testing, limitations</summary>

### Why Windows needs a custom `velta://` scheme

Windows does **not** allow a normal desktop app to intercept a specific `https://` host like `i.delta.chat` — that power belongs to the default browser. So on Windows Velta registers a custom URI scheme (`velta://`) through `tauri-plugin-deep-link`. The first time the app runs it writes the registry entry for the scheme, after which the OS will launch Velta for any `velta://…` link.

### Wrapping an invite link for Windows

Take an official Android invite link:

```
https://i.delta.chat/#DD1FDB8A5621D4A89DE00542234A2D9967B07594&v=3&i=fbrK144cdHV&s=GI2Y07eCqylGp6j5J_QCZ1vz&a=0so6eoc9s%40d13.buro.dev&n=Pavel
```

Encode the part after `url=` and build a `velta://` link:

```
velta://invite?url=https%3A%2F%2Fi.delta.chat%2F%23DD1FDB8A5621D4A89DE00542234A2D9967B07594%26v%3D3%26i%3DfbrK144cdHV%26s%3DGI2Y07eCqylGp6j5J_QCZ1vz%26a%3D0so6eoc9s%2540d13.buro.dev%26n%3DPavel
```

Quick JavaScript helper:

```js
function toVeltaInvite(httpsUrl) {
  return "velta://invite?url=" + encodeURIComponent(httpsUrl);
}
```

Clicking that link will focus an existing Velta window or start a new one, show a progress modal, and run `secureJoin()` against the decoded invite.

### How it is implemented

- **Android** — `velta-app/src-tauri/gen/android/app/src/main/AndroidManifest.xml` declares `VIEW` intent filters for `https://i.delta.chat` and mirror domains (`i.gluek.info`; one filter each — add more there and rebuild to extend OS-level interception). The Rust layer emits the URL to the frontend as a `deeplink` event.
- **Windows/Linux** — `tauri-plugin-deep-link` registers the `velta://` scheme. `tauri-plugin-single-instance` (with the `deep-link` feature) forwards second-instance launches to the running window. The plugin emits a `deep-link://new-url` event that the frontend listens to.
- **Common frontend handling** — `app/js/app.js` has `extractJoinLink()`, `extractInviteLink()`, and `extractVeltaLink()`. They normalise every supported format and route it to either the SecureJoin flow (`joinFromInvite`) or the account-setup flow (`addAccountFromInvite`). Link recognition, mirroring, and the invite-card rendering live in `app/js/invites.js`.

### Testing locally

- **Android** — tap an `https://i.delta.chat/#…` link from any app. The system should offer to open it with Velta.
- **Windows** — after installing and running Velta once, open a `velta://invite?url=…` link from a browser address bar or a local HTML file. The app should open and show the join progress modal.

### Limitations

- Windows cannot intercept the official `https://i.delta.chat/#…` links directly. To make those links open Velta automatically on Windows, a browser extension that rewrites them to `velta://` URLs would be required.
- macOS deep links are configured in the same `velta://` desktop path, but they are currently untested.



</details>

<details>
<summary>Sending files, photos and videos</summary>

The composer has a paper-clip attachment button, and images can also be
**pasted from the clipboard** (paste a screenshot straight into the composer).
Both paths run through the same send-image flow: a preview with an optional
**caption** and a free-form **Crop** step (drag to move the selection, corner
handle to resize) before sending. From the attachment menu you can send:

| Type | How it is sent | How it is shown |
|---|---|---|
| Photo | `viewtype: Image` with the original file path | Rendered inline as an `<img>` |
| Video | `viewtype: Video` | Rendered inline as a `<video controls>` element |
| Audio / voice | `viewtype: Audio` or `Voice` | Rendered inline as an `<audio controls>` element |
| Any file | `viewtype: File` | Shown as a file card with name, size and a download/open action |

Implementation files:

- `app/js/chat-view.js` — attachment menu, native file picker (`plugin:dialog|open`), media rendering and the download button.
- `app/js/rpc-core.js` — `sendMessage()`, `getMessage()` and `downloadFullMessage()` wrappers around the core JSON-RPC methods.
- `app/css/main.css` — styles for `.msg-image`, `.msg-video`, `.msg-audio` and `.msg-file`.

### How media is loaded

Real media blobs live in the Delta Chat account directory and cannot be reached by a `file://` URL from the WebView. `app/js/media.js` resolves paths through a three-tier chain:

1. **`blobfile://` custom protocol** (primary once boot-probed) — a Tauri URI-scheme handler in `lib.rs` serves account-dir-scoped blobs with real 206 range responses, no TCP listener. At startup the frontend loads a probe image through the scheme; a webview that never dispatches custom-protocol requests (WebView2's media stack can bypass them even when images through the same scheme load) keeps the legacy chain.
2. **Loopback media HTTP server** — `127.0.0.1:20810`, random per-launch token, account-directory-scoped, real ranges. This is the probe-negative path and the one-shot per-element fallback: `<img>`/`<video>`/`<audio>` that fail on a blobfile URL swap to it once before showing an error placeholder. On Android this server remains what `<video>`/`<audio>` can always rely on, since the asset protocol there answers the first range read but fails mid-file ones, which kills demuxing of moov-at-end MP4s (most phone recordings). Cleartext is permitted app-wide (network security config) so user-opened http links render in the in-app browser; the SPA itself never navigates top-level and its CSP blocks plain-http subresources, so the shell's own cleartext traffic stays the loopback media server.
3. **Tauri asset protocol** — plain GETs (posters) work everywhere.

Files are opened with `plugin:opener|open_path`. Posters for the click-to-play placeholder are extracted once per file (blob read → hidden `<video>` → canvas → WebP) into `velta-posters/` inside the account directory and served through the asset protocol.

### Video placeholder: poster frame and size badge

The click-to-play widget shows the extracted poster frame, the file size badge in the top-left corner and the duration in the bottom-right. Extraction is lazy (only when the row is mounted), serialized to one decode at a time, skipped for files above 128 MB, and cached on disk so later mounts are instant. Any failure falls back to the plain placeholder.

### Downloading large messages

Delta Chat splits very large messages into a small placeholder plus a downloadable body. When a message has `downloadState` other than `Done`, Velta shows a card with a download icon instead of the media player. Tapping it calls `download_full_message(msgId)` and then refreshes the message, which swaps the placeholder for the real image / video / audio player or the open-file card.

</details>

<details>
<summary>Media internals: size limit, caching, platform notes</summary>

### Attachment size limit

`Config::DownloadLimit` defaults to `0` (no automatic size limit), so the core normally downloads the whole message automatically. For outgoing attachments the Delta Chat core recommends staying below roughly **18 MB** of raw file data (around 24 MB after base64 encoding), defined by `RECOMMENDED_FILE_SIZE` in `deltachat-core-rust`. Velta does not enforce this itself; it just passes the file to the core.

`Config::MediaQuality` (`0` = Balanced, `1` = Worse) controls image compression on send, so the UI does not need to resize images before sending.

### Media caching and chat switching

Switching chats is tuned to avoid redundant work: the rendered-message LRU
(`_rowCache` in `app/js/chat-view.js`) survives chat switches — reopening a
chat reuses its rendered rows instead of rebuilding them (it is only dropped
when the account changes, since message ids are per-account). Media responses
are served `Cache-Control: max-age=31536000, immutable`: core blob names are
content-deduplicated, so the same URL always means the same bytes and the
WebView serves images from its cache instead of re-reading and re-decoding
them on every visit.

### Platform notes

- **Windows / desktop** — file pickers return real filesystem paths and everything works end-to-end.
- **Android** — the Tauri dialog may return a `content://` URI that the Delta Chat core cannot read directly. Velta copies picked files into the app’s local data directory using `tauri-plugin-fs` before passing an absolute path to `send_msg`.



</details>

<details>
<summary>Message formatting and replies</summary>

Message text renders a simple, escape-first markdown subset (`app/js/markdown.js`):

| Syntax | Result |
|---|---|
| `**bold**` | **bold** |
| `*italic*` / `_italic_` | *italic* |
| `__underline__` | underline |
| `[label](https://…)` | clickable link (bare URLs linkify too) |
| `- item` / `* item` / `+ item` | bulleted list |
| `1. item` / `1) item` | numbered list (a start value like `3.` is honored) |

Messages whose original differs from the simplified bubble — the core's mail
simplifier cut a footer/quote (the text ends in `[...]`), or an HTML mail was
flattened to text — render a **Show Full Message…** button (the official
client's label). Tapping it loads the original body from the core
(`get_message_html`) and renders it in the same isolated viewer as HTML
attachments: a sandboxed iframe in an opaque origin, so scripts run but can
touch nothing of the app. Forwarded copies carry no stored original and get
no button. Remote images inside the mail stay blocked by default (the page
CSP applies inside the viewer) — nothing about you leaks to mail-embedded
trackers.

Everything is HTML-escaped before any tag is produced and only `http(s)` targets become links, so message content can never inject markup. Emphasis markers are word-boundary guarded (`2*3*4` and `snake_case_name` stay literal). Invite links (`i.delta.chat` and registered mirror domains) render as invite cards instead of links — see [Deep links](#deep-links). Invites carrying a `b=` parameter are broadcast channels and render as *"Subscribe to ChannelName"* with a Subscribe confirmation instead of the group wording.

Hovering a message on desktop shows a small **Reply** pill at the bubble's top-right corner — one click sets the reply (same pipeline as the context menu's Reply) and focuses the composer. The pill is hidden on touch devices and during message selection.

Note: other Delta Chat clients render only the core's markdown subset (bold, italic, strikethrough, code). Underline and lists are Velta-side rendering niceties — other clients show those markers literally.

</details>

<details>
<summary>Editing sent messages</summary>

Your own text messages can be edited after sending: long-press/right-click the
bubble and pick **Edit**. The composer switches to edit mode ("Editing
message" bar, ✕ cancels); Enter applies. Editing updates the message in place
for every chat member (the bubble shows an *edited* tag), reuses Delta Chat
core's edit delivery (a hidden edit message synced to recipients), and is
restricted to what the core allows: your own, plain-text, non-empty messages —
no attachments, captions, info or HTML mail bodies. P2P local chats don't
support editing yet.

</details>

<details>
<summary>Stickers</summary>

Stickers (Delta Chat's <code>Sticker</code> view type) render the way the
official clients show them: floating on the chat background without a bubble
around them, at a compact size. The composer's input field has a sticker
button on the right edge that opens a picker fed by the account's sticker
folder (the same mechanism as Delta Chat desktop — collections are folders
under the account's <code>stickers/</code> directory, shared with a desktop
install of the same account). Long-press a sticker you received and pick
**Save sticker** to add it to the picker. In demo mode the picker ships a
few emoji placeholders.

</details>

<details>
<summary>Notifications</summary>

Incoming-message notifications mirror the official client's conversation
layout on both mobile platforms:

- **Android** — real MessagingStyle conversations: group name as the title,
  sender name as the second line, plain message text below (never a
  "GroupName: text" prefix); the sender's avatar on the left, the chat
  avatar on the right; follow-up messages of one chat group into a single
  conversation instead of stacking cards. Built by the background event
  poller through a small Kotlin helper while the app is hidden.
- **Windows** — a toast with three text lines (chat name / sender / text)
  and the sender's avatar cropped circular, rendered via the same
  notification identity the installer registers. For the identity to
  resolve, the app must have been installed through the installer at least
  once (PWA-in-browser and pre-install dev runs show no toasts).

1:1 chats show the sender as the title with just the message text.

**UnifiedPush (Android, groundwork):** if a UnifiedPush distributor app
(ntfy, NextPush, self-hosted — your choice, no Google) is installed with a
default set, Velta registers with it automatically and uses the push channel
to fetch messages the moment the server announces them. The relay-side
notifier must support `webpush:` push tokens (stock chatmail deployments
with the notifier enabled do). The foreground service stays on for now, so
this is currently an instant-fetch booster rather than a battery saver.

</details>

<details>
<summary>Diagnostics &amp; debugging</summary>

The pinned "Velta Diagnostics" chat collects startup, core and error
diagnostics in a screencap-visible console style — no adb or logcat needed.
Its action bar carries two switches: **Logging** freezes/resumes the shell
log (`velta.log`), and **DevTools** opens the WebView inspector on Windows
or enables remote debugging (`chrome://inspect` over USB) on Android. The
same bar offers a "Restart: Core | UI" recovery group and a pause/play
toggle that freezes the live log (events keep being recorded while paused).

</details>

<details>
<summary>One-click updates (Windows)</summary>

On Windows the drawer's update banner grows an **Update** button: one tap
checks the update feed, downloads and signature-verifies the new installer
(tauri-plugin-updater, minisign), runs it and relaunches the app — no browser,
no manual download. Progress shows on the button; the check gate is unchanged
(version.txt first, the signed manifest re-validated at install). Only
installs made through the NSIS installer can self-update; a bare
`velta-app.exe` copied somewhere still needs a manual installer run. Android
keeps the banner's Download APK flow (system installer takes over) — see
[AUTOUPDATEPLAN.MD](AUTOUPDATEPLAN.MD) for the roadmap.

</details>

<details>
<summary>Deleting messages</summary>

Deleting a message (long-press / right-click → Delete) opens the same dialog as
official Delta Chat desktop:

| Action | What happens |
|---|---|
| **Delete for me** | Removes the message on this device and deletes it from the relay's storage. Other members keep their copy. |
| **Delete for everyone** | Also asks every chat member's device to delete the message. The core sends a hidden, encrypted deletion request (`Chat-Delete` header) that other Delta Chat clients honor. |

"Delete for everyone" is only offered when the core can support it: the
selected messages must be **your own** and **end-to-end encrypted**, and the
chat must not be Saved Messages. Deleting for everyone is a request — members
running clients without deletion support will keep their copy.

Related indicator: encrypted chats show no lock icon (e2e is the default).
Unencrypted 1:1 chats — classic-email contacts that chatmail relays cannot
encrypt to — are marked with a small open-shackle lock in the chat list and
chat header instead.

</details>

<details>
<summary>Webxdc mini-apps (beta)</summary>

Messages containing a `.xdc` mini-app render as an app card — the app's
icon (or a letter tile with the app initial when the app ships none), the
app's name and summary from its manifest, and a Start button; tap to open
the app in a full-screen overlay (opaque-origin sandbox, close button in the
title bar). The iframe runs **without** `allow-same-origin`, so every app
document gets a unique opaque origin: mini-apps can reach neither the host
page nor each other's data, and the injected shim backs
`localStorage`/`sessionStorage` with memory in that origin (app state
syncs to every chat member through end-to-end encrypted status updates,
and the relay's STUN/TURN servers power the connection). The app frame is
themed to match the shell (dark canvas, dark scrollbars) — an app can still
set its own `color-scheme`. `sendToChat` (including file export to a chat)
and the file-picking `importFiles` are wired; realtime (low-latency)
channels are not — apps that rely on them degrade gracefully to status
updates.

</details>

<details>
<summary>Bot commands</summary>

Messages from bots render their slash commands as tappable chips right in
the bubble — tap one and the command lands in the composer, ready to send.
Works for any bot chat; the chips are extracted from the bot's own message
text, so nothing needs to be configured per bot.

</details>

## UX (design decisions)

<details>
<summary>Identity avatars &amp; contact profiles</summary>

Every **user** avatar renders a deterministic **color matrix** derived from the
contact's OpenPGP fingerprint: an equal-height 4-row grid (3 squares, 2 rects,
2 rects, 3 squares — one cell per fingerprint group), with a fingerprint glyph
centered on a soft-black badge for photo-less contacts, and the contact's photo
as a padded rounded square (with a thin dark ring) for contacts that set one.
Neighboring cells never share similar hues, all colors are soft (no pure
black/white), and everything is drawn as pure SVG in `app/js/avatar.js` —
painted as a CSS background image per tile (one cached image per fingerprint,
no inline SVG subtrees), so it stays sharp at any size without costing DOM.

Tapping any avatar in a chat opens the **contact profile** modal: the large
photo avatar beside the captioned identity tile (color names included), the
contact's address and profile key (OpenPGP fingerprint), last-seen info, plus
**Send message**, **Edit name** and **Block** actions. Group chats also show a
**Chats in common** section listing the groups you share with that contact.

Group avatars intentionally keep a solid color with a full-bleed photo or
initials — the identity matrix is a per-contact feature.

**Verified badge.** A blue rosette next to a contact's name (chat header,
profile sheet) means Delta Chat key-contact verification: you hold their
verified key from a **secure-join QR handshake** — scanned directly, or
introduced by a verifier you already trust (shown as "Verified" in the
profile). The rosette appears once the chat head hydrates the contact
(`refreshChatHeadPresence`), and the profile sheet's Verified row and
"Chats in common" stay the place to inspect the details. It is deliberately
absent from bare chat-list rows: verification is a per-contact property the
chat-list payload does not carry, and hydrating a contact per row would cost
an RPC each. Contact verification is a 1:1 concept — group protection status
is a separate core feature the JSON-RPC chat types don't expose yet.

**Brutal theme** (Settings → Theme → Brutal). A third, always-dark theme
built on neobrutalism principles and translated to Velta's token set — no
React/TypeScript, just a `html[data-theme="brutal"]` block in `main.css`:
flat panels with 2px ink borders, hard offset shadows, small radii, hover
press-down, and a vivid main yellow for selected rows and outgoing bubbles
(ink text on yellow, with dedicated quote/blockquote/meta colors). Like
every Velta theme it avoids pure black and pure white. Being explicit, it
never participates in the Auto (system) switch.

**Chat-list action bar.** The bottom bar in the chat list switches what the
list shows: **Chats** (default), **Contacts** (tap to open the chat),
**Calls** (recent calls on this device), **QR** (your invite code rendered
in place of the list, with a scan button), **+** (new chat / group /
join-via-link menu) and **Menu** (settings drawer). The header search button
works the same way — it opens a live chat-name search in place of the list
and flips to a cross to close. The core keeps no call log — calls exist only
as call messages — so the Calls view lists calls ended on this device,
recorded locally and capped at 30. Every view button can be hidden in
Settings → Bottom bar buttons; the Menu and + buttons are always visible,
and when all view buttons are hidden the bar's background turns transparent.
The list renders contact rows through a virtual scroller, so large address
books don't inflate the DOM.

**History loading strip.** While a chat's history loads — opening it or
paging up to older messages — a thin blue gradient sweeps left-to-right just
under the chat header (relay-blue, the same family as the status strip). It
stays on for at least 150 ms so fast loads still register, a new load cancels
a pending fade so back-to-back pages read as one strip, and it is disabled
under `prefers-reduced-motion`.

**Avatar shimmer placeholders.** Photo avatars (contact photos and custom
group photos) show a soft skeleton sweep while their bytes are in flight;
the sweep rides as the image's own background, so it costs zero extra DOM,
disappears the instant the photo decodes, and cached avatars skip it
entirely. Same soft-grey family as the loading strip, disabled under
`prefers-reduced-motion`.

**Times are 24-hour** (`03:21`, never `03:21 AM`) regardless of device
locale; relative times ("last seen", call lists) stay humanized.

</details>

<details>
<summary>Theming and accessibility</summary>

The palette avoids pure black and pure white everywhere — whites live in the `#f2f2f5`/`#f4f4f4` family and blacks in the `#0b0b10`–`#1c1c26` family (the avatar identity tiles already followed this rule). Text and surface pairs are held to **WCAG AA (≥ 4.5:1 contrast)**, measured with the WCAG relative-luminance formula after compositing any translucent layers:

| Pair (dark theme) | Contrast |
|---|---|
| Body text `#f2f2f5` on app background `#0f0f14` | 17.1 : 1 |
| Bubble text on incoming bubble `#1c1c26` | 15.1 : 1 |
| Bubble text on outgoing bubble `#2b5278` | 7.3 : 1 |

Reply quotes use a dedicated palette per bubble and theme (the generic accent/dim colors measured as low as 2.08 : 1 on the blue outgoing bubble): the quote name and text now measure **5.2 – 7.0 : 1** in every theme/side combination. When introducing a new color, composite it over its real background (rgba layers included) and check the ratio before merging.

</details>

<details>
<summary>Known limitations</summary>

- **In-app browser (Android)** — message links open without leaving Velta, through a three-step chain. (1) A Chrome Custom Tab using your real browser session: the tab is launched from the Activity context (launching from the application context crashed on a missing `FLAG_ACTIVITY_NEW_TASK` — modern androidx stopped adding it) and targets an explicit provider, chosen by your default browser first (since 1.4.14: if your default browser can host a Custom Tab it is used, so links no longer land in a non-default browser like Chrome Dev just because it sorts earlier; previously any visible `CustomTabsService` provider was picked by package order, with `CustomTabsClient.getPackageName` as backup) — a bare intent would resolve like `ACTION_VIEW`, so devices whose default browser has no Custom Tabs support (e.g. vivo.browser) opened a full browser task instead. (2) Devices with no provider at all get a native second-`WebView` overlay (`openWebView`, driven by the `open_webview_browser` command): a fullscreen in-app browser with a dark bar (host, open-external, close), BACK-driven history, JS + domStorage on, file/content access off and no bridges exposed. Being a top-level browsing context it is immune to X-Frame-Options, and plain-http sites render (cleartext permitted — see media notes). (3) Only old shells fall back to the JS iframe overlay. The overlay's sandboxed iframe cannot show sites that send X-Frame-Options / frame-ancestors (Chromium blocks with `net::ERR_BLOCKED_BY_RESPONSE`) — the bar's external-open button is the escape hatch. The Custom Tab class (`org.velta.InAppBrowser`) is cached as a JNI global ref at startup (`setApplicationContext` in `lib.rs`) because `find_class` for app classes is unreliable from Rust worker threads. The page title in the overlay is fetched separately by the shell (`fetch_page_title`, 5 s timeout, 256 KB cap).
- Group creation, contact discovery, QR invites, and real-time message rendering all work in basic flows but have not been stress-tested.
- Logging to `velta.log` is disabled in the stable branch; use the status pill and browser/Tauri dev tools to diagnose issues.
- On Windows, the app needs the sidecar binary to talk to the real core. If the sidecar fails to start the frontend falls back to the mock core.
- On Android, the in-process core rides a built-in foreground service (`CoreService`): messages keep syncing and arrive as conversation notifications while the app is backgrounded — see [Notifications](#notifications). A background event poller (not the WebView) builds them while the app is hidden. A separate headless service APK (`velta-core-service/`) still exists for the PWA-in-browser mode.

</details>

## Privacy &amp; security

<details>
<summary>Privacy: zero analytics &amp; telemetry</summary>

Velta ships **zero analytics, telemetry, or crash reporting** — verified
against the codebase: the frontend's only network calls go to loopback helper
services on your own device, and the Delta Chat core talks exclusively to the
chatmail relays you configure (that is the messaging itself; calls use the
relays' STUN/TURN when needed). There is no update-check, no usage tracking,
and no crash uploader. One installer-level exception: on Windows, a machine
missing the WebView2 runtime fetches it via Tauri's install bootstrap — that
is the installer, not the app, and it sends nothing about you.

</details>

<details>
<summary>HTML attachments (isolated in-app rendering)</summary>

HTML files sent into a chat open **inside Velta, isolated**: the attachment
renders in a sandboxed iframe with no `allow-same-origin`, so its scripts run
in an opaque origin that cannot touch the app, your sessions, or cookies
(links inside are inert by design — the sandbox blocks popups and top-level
navigation). The viewer is themed to match dark/light via an injected
`color-scheme`, and the file is never copied to a temp file or opened in the
system browser.

</details>

<details>
<summary>Content Security Policy</summary>

Both delivery paths ship a restrictive CSP rooted in `default-src 'self'`:
the Tauri shell injects it as a response header (`tauri.conf.json` /
`tauri.android.conf.json`), and `app/index.html` carries the same policy as a
meta tag for the browser/PWA path, where no Tauri header exists. Scripts are
strictly same-origin — no inline scripts, no `unsafe-eval`; the pre-paint
interface-scale snippet is an external file (`app/js/ui-scale.js`) for exactly
that reason. `img-src`/`media-src`/`frame-src` open only the app's own media
surfaces: the `blobfile:` custom protocol, the loopback media server, and the
opaque-origin `webxdc:` sandbox. The three policy copies must stay in sync
when origins change. The standalone diagnostics page (`diag.html`) is a dev
tool with its own looser policy (`unsafe-inline` for its single inline
script).

</details>

<details>
<summary>License</summary>

See [`LICENSE`](LICENSE).

</details>

## Under the hood &amp; building

<details>
<summary>Core upgrades</summary>

The Delta Chat core is vendored in `core/` and consumed three ways: as the
Windows sidecar binary, as the in-process library inside the Android APK, and
as the prebuilt `deltachat-backend/` servers used by the PWA/test rig. The
frontend talks to it over one integration point (`app/js/rpc-core.js`), so a
core change can surface as frontend symptoms (event storms, re-render churn)
rather than clean errors. [COREUPDATE.md](COREUPDATE.md) is the step-by-step
upgrade plan: the RPC/event contract to preserve, offline gates, live and
two-account checks, the event-storm regression pass, device checks, and
rollback rules. What each core release gives Velta — the new features rated
by value with their integration notes — lives in
[CORE-CAPABILITIES.MD](CORE-CAPABILITIES.MD).

</details>

<details>
<summary>Project layout</summary>

```
.
├── app/                        # Velta web frontend (vanilla JS, no build)
├── velta-app/              # Tauri 2 wrapper for Windows + Android
│   └── src-tauri/
│       ├── Cargo.toml          # Rust crate + deltachat-jsonrpc dependency
│       ├── tauri.conf.json     # shared Tauri config
│       ├── tauri.android.conf.json
│       ├── tauri.ios.conf.json
│       ├── gen/android/        # generated Android project
│       └── src/
│           ├── lib.rs          # sidecar + Android in-process core glue
│           ├── p2p.rs          # local chat engine (iroh QUIC pairing + 1:1 chat)
│           ├── bin/p2p-hub.rs  # headless terminal hub (debug helper)
│           └── main.rs         # Tauri entry point
├── velta-core-service/         # Android background-service (JNI + WS bridge) APK
├── deltachat-backend/          # Prebuilt deltachat-rpc-server binaries
│   ├── windows-x86_64/
│   └── android-arm64/
├── tools/                      # icon generation, WSL APK build/sign helpers,
│                               # serve-dev.py (no-cache static server for app/)
├── signing/                    # local signing keystore (untracked)
└── core/                       # Vendored Delta Chat core Rust workspace
```

</details>

<details>
<summary>Libraries &amp; dependencies</summary>

The runtime has exactly **two vendored JavaScript libraries** — everything else
in `app/js/` (markdown renderer, avatar matrix, invite parsing, diagnostics)
is hand-rolled for Velta.

| Library | What it does here | Upstream |
|---|---|---|
| [Elena](https://github.com/arielsalminen/elena) (`@elenajs/core` v1.0.1) | Tiny progressive web-components library — powers `<velta-avatar>`, `<velta-chat-item>`, `<velta-chat-head>`, `<velta-video>` | [arielsalminen/elena](https://github.com/arielsalminen/elena) |
| [virtual-scroller](https://github.com/catamphetamine/virtual-scroller) (`virtual-scroller-dom`) | Windowed rendering of the message history with variable-height rows, seamless prepends and scroll restoration | [catamphetamine/virtual-scroller](https://github.com/catamphetamine/virtual-scroller) |
| [Tauri 2](https://github.com/tauri-apps/tauri) | Desktop/Android shell, deep links, sidecar process | [tauri-apps/tauri](https://github.com/tauri-apps/tauri) |
| [Delta Chat core 2.61.0](https://github.com/chatmail/core) | The messaging engine (Rust): contacts, chats, e2e crypto, IMAP/SMTP | [chatmail/core](https://github.com/chatmail/core) |

Both JS libraries are vendored under `app/vendor/` (no bundler, no `node_modules`
at runtime). UI icons are individual SVGs from [SVG Repo](https://www.svgrepo.com/).

</details>

<details>
<summary>Requirements</summary>

- Rust **1.89+**
- Node.js **22+** (only for the Tauri tooling)
- `cargo-tauri` v2

```bash
cargo install tauri-cli --version "^2.0" --locked
```

### Windows build

- Windows 10/11
- For building the sidecar from source: Perl + NASM (needed by vendored OpenSSL in `rusqlite`).
- **Encoding:** all repo files are UTF-8 without BOM. On Cyrillic-locale Windows the
  ANSI codepage is CP1251, and PowerShell 5.1 / `cmd` redirection using the default
  encoding silently corrupts non-ASCII (`—` → `вЂ”`, `…` → `вЂ¦`, emoji → `рџ…`). Always
  pass `-Encoding utf8` explicitly (and beware `Set-Content -Encoding UTF8` writing a
  BOM — see AGENTS.md §6.2), or write from WSL. If you ever see stray Cyrillic in
  English prose, fix the write path — never just the characters.

### Android build

- Android SDK + NDK r27 (e.g. `ndk;27.2.12479018`)
- JDK 17
- Targets installed via rustup:
  `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-androideabi`, `x86_64-linux-android`

#### WSL-only NDK note

If you install the NDK inside WSL (e.g. `~/android/sdk/ndk/r27c`) make sure the extracted NDK preserves symlinks. Python's `zipfile` module strips symlinks by default, which breaks the LLVM toolchain. Extract the NDK zip with a symlink-aware tool such as `unzip` or a small Python helper that checks `zipfile.ZipInfo.create_system == 3` before writing entries. After extraction verify that toolchain binaries like `toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang` resolve correctly.

</details>

<details>
<summary>Build locally</summary>

### Windows installer

Build the sidecar first:

```bash
cd core
cargo build -p deltachat-rpc-server --release
```

Stage it for Tauri:

```powershell
New-Item -ItemType Directory -Force -Path "velta-app/src-tauri/binaries"
Copy-Item "core/target/release/deltachat-rpc-server.exe" `
  "velta-app/src-tauri/binaries/deltachat-rpc-server-x86_64-pc-windows-msvc.exe"
```

Then build the installer:

```bash
cd velta-app
cargo tauri build
```

Output:

- `velta-app/src-tauri/target/release/bundle/msi/*.msi`
- `velta-app/src-tauri/target/release/bundle/nsis/*.exe`

### Releases via GitHub Actions

The `Release` workflow (`.github/workflows/release.yml`) builds both artifacts
and publishes them as a GitHub release. It runs on every `v*` tag push and can
also be triggered manually from the Actions tab (it then creates the matching
tag itself). The release assets are named after the version in
`velta-app/src-tauri/tauri.conf.json` — the single source of truth:

- `Velta-<version>-<abi>.apk` — signed Android APK (`build-android.yml`)
- `Velta_<version>_x64-setup.exe` — NSIS Windows installer (`build-windows.yml`),
  plus its `Velta_<version>_x64-setup.exe.sig` updater signature
- `latest.json` — Windows self-update manifest (installer URL + signature, fed
  to `tauri-plugin-updater`). Must stay the **last** asset uploaded: it lives
  at `releases/latest/download/latest.json` and points at the installer in the
  same release — a manifest visible before its installer bricks that update
  cycle.
- `version.txt` — just the version. Apps fetch
  `releases/latest/download/version.txt` at startup and, when it reports a
  newer version than the running build, show an update banner at the bottom
  of the drawer plus a subtle pulsing highlight on the drawer's menu button
  (1.4.14+). Windows 1.4.20+ turns the banner button into a one-click
  **Update** (see above); Android keeps Download APK.

**Release changelog**: the release body is generated automatically — every
commit subject since the previous tag, plus a compare link.

**Changelog feed**: after a tag release publishes successfully (both builds
+ the GitHub release), the `Release` workflow posts a notification to
`ntfy.gluek.info/velta_changelog` — title `Velta: version bumped to
<version>`, body = the tagged commit's full message with a link, `Velta` +
`robot` tags. Builds run only on `v*` tag pushes (or manual dispatch);
ordinary branch pushes don't build anything. `build-windows-cross.yml`
(Ubuntu sidecar cross-compile build) is manual-dispatch only as well.
Do not add per-job `concurrency` blocks to `build-android.yml` /
`build-windows.yml`: inside a reusable-workflow call `github.job`
evaluates empty, so both calls collapse into one concurrency group and
cancel each other (that is what silently killed the 1.4.6–1.4.8
releases). Serialization belongs to the calling workflow.

APKs are signed with the persistent release keystore stored in the repo
secrets (`ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`), so every build upgrades in
place over the previous one. Without the secrets (forks/PRs) the workflow
falls back to an ephemeral key and warns — those APKs must not be published.

### Android APK (arm64-v8a phones)

```bash
cd velta-app
cargo tauri android build --apk --target aarch64
```

The unsigned APK will be in:

```
velta-app/src-tauri/gen/android/app/build/outputs/apk/arm64-v8a/release/
```

To sign it locally:

```bash
keytool -genkey -v -keystore velta-debug.keystore -alias velta \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass velta123 -keypass velta123 -dname "CN=Velta"

zipalign -p -f 4 app-arm64-v8a-release-unsigned.apk app-arm64-v8a-release-zipaligned.apk

apksigner sign --ks velta-debug.keystore \
  --ks-pass pass:velta123 --key-pass pass:velta123 \
  --out app-arm64-v8a-release-signed.apk \
  app-arm64-v8a-release-zipaligned.apk
```

Add `--split-per-abi` if you need separate APKs for other architectures.

</details>

<details>
<summary>GitHub Actions</summary>

Pre-configured workflows live in `.github/workflows/`:

| Workflow | What it builds |
|---|---|
| `build-android.yml` | arm64-v8a Android APK on `ubuntu-latest` |
| `build-windows.yml` | Windows installer on `windows-latest`, compiling the sidecar natively (needs Perl + NASM) |
| `build-windows-cross.yml` | Windows installer where the sidecar is cross-compiled on Ubuntu to avoid installing Perl/NASM on Windows |

The Android and cross-compiled Windows workflows are the easiest starting points if you just want an artifact.

</details>
