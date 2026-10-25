# Settings export and apply (Saved Messages)

Velta keeps UI preferences per device (localStorage). To move them to another
device without a sync service, **drawer → Export settings to Saved Messages**
sends one plain-text message to the account's own Saved Messages chat. On the
other device (same account), the message gets an **Apply these settings**
button; it opens a confirm listing every change (current → new) and applies
them live after you confirm. Nothing happens automatically: export is a manual
tap, and apply always asks first.

Code: `app/js/settings-transfer.js` (whitelist, serializer, parser, diff,
apply), `app/js/app.js` (`exportSettingsToSaved`, `applySettingsFromMessage`,
`settingsDiffModal`, `refreshAfterSettingsApply`), `app/js/chat-view.js`
(bubble action), `app/js/ui.js` (drawer button). Tests:
`tests/settings-transfer.test.mjs`.

## Why the drawer, last item before About

The export covers every settings section (theme, chat appearance, bottom bar,
notifications, media, chats), so it doesn't belong to any one of them.
Putting it at the end of the drawer, next to About, keeps it out of the way
of the daily toggles. You use it rarely, and it's easy to find when you need
it.

## Format

```
Velta settings v1 (2026-10-18)
theme: auto
language: english
interface-scale: normal
message-text-size: 15.5
message-corners: default
accent-color: default
hyphenation: on
bottom-bar-buttons: chats, contacts, calls, qr
chat-categories: people, groups, channels, bots, system
notifications: on
notify-replies-only: off
notify-show-content: on
notify-system: on
notify-vibration: on
notify-sounds: on
notify-calls: on
image-quality: standard
compress-photos: on
auto-download-limit: none
link-previews: off
strip-tracking: on
send-on-enter: on
read-receipts: on
remember-scroll: on
local-chat-typing: on
(Apply on another device: open this in Saved Messages and tap Apply these settings.)
```

- Line 1: `Velta settings v1`, optionally followed by ` (YYYY-MM-DD)` (local date).
- Then one `key: value` line per setting, in a fixed order. Every setting is
  always written, so applying it reproduces the source device exactly.
- Lines in parentheses are notes. Blank lines are allowed.
- The accent is written as bare hex (`3fa34d`): `#3fa34d` would render as a
  hashtag button in the bubble. The parser accepts both forms.

## Included keys

| Key | Values | Storage |
| --- | --- | --- |
| `theme` | `auto`, `dark`, `light`, `brutal` | `dw-theme` |
| `language` | `english`, `french`, `russian` | `velta-lang` |
| `interface-scale` | `small`, `normal`, `large` | `velta-ui-scale` |
| `message-text-size` | 10–22 (step 0.5, `px` optional; clamped) | `velta-msg-font-size` |
| `message-corners` | `default` or 0–14 (clamped) | `velta-bubble-radius` |
| `accent-color` | `default` or 6-digit hex | `velta-accent` |
| `hyphenation` | on/off | `velta-hyphens` |
| `bottom-bar-buttons` | visible subset of `chats, contacts, calls, qr`, or `none` | `velta-bar-hidden` |
| `chat-categories` | visible subset of `people, groups, channels, bots, system`, or `none` | `velta-cats-hidden` |
| `notifications` | on/off | `velta-notify` |
| `notify-replies-only` | on/off | `velta-notify-mentions` |
| `notify-show-content` | on/off | `velta-notify-text` |
| `notify-system` | on/off | `velta-notify-system` |
| `notify-vibration` | on/off | `velta-notify-vibration` |
| `notify-sounds` | on/off | `velta-notify-sounds` |
| `notify-calls` | on/off | `velta-notify-calls` |
| `image-quality` | `standard`, `compact` | `velta-media-quality` (+ core `media_quality`) |
| `compress-photos` | on/off | `velta-compress-photos` |
| `auto-download-limit` | `none`, `1MB`, `5MB`, `25MB` (`640KB` applies as `1MB`) | `velta-download-limit` (+ core `download_limit`) |
| `link-previews` | `off`, `picture`, `fetch` | `velta-link-preview` |
| `strip-tracking` | on/off | `velta-strip-trackers` |
| `send-on-enter` | on/off | `velta-send-enter` |
| `read-receipts` | on/off | `velta-mdns` (+ core `mdns_enabled`) |
| `remember-scroll` | on/off | `velta-remember-scroll` |
| `local-chat-typing` | on/off | `velta-p2p-typing` |

on/off also accepts `yes/no` and `true/false` (any case). Default values
remove their storage key (the "absent = default" pattern).

## Excluded (never exported, never written by apply)

The following are private or tied to one device:

- Relays and transports, including the send transport (core config).
- Proxy and DNS tunnel settings.
- Keys and account addresses.
- Multi-device (`bcc_self`).
- The device info block.

In localStorage, `EXCLUDED_STORAGE_KEYS` lists these keys explicitly. A test
fails if any of them shows up in the whitelist:

`velta-ws-relay`, `velta-ws-relays`, `velta-push`, `velta-bridge-token`,
`velta-identity`, `velta-bcc-self-choice`, `velta-invite-hosts`,
`velta-invite-creds`, `velta-short-invites`, `velta-lufi-server`,
`velta-lufi-files`, `velta-p2p`, `velta-p2pg-hidden`, `velta-notify-bg`,
`velta-notify-bgforce`, `velta-low-battery-react`, `velta-battery-opt-asked`,
`velta-sync-only-active`, `velta-logging`, `velta-debug`, `velta-mock`,
`velta-mock-fresh`, `velta-wasm`, `velta-tunnel-log`, `velta-tunnel-diag-seen`,
`velta-read-markers`, `velta-recent-commands`, `velta-recent-apps`,
`velta-xdc-mirrors`, `velta-xdc-mirror-ok`, `velta-link-preview-chats`,
`velta-chat-category`, `velta-ask-notifications`, `velta-pending-invite`,
`velta-pending-add`, `velta-call-log`.

## Parser rules (strict and safe)

- No `eval`, no JSON taken from the message. Values are matched against fixed
  patterns and mapped to canonical strings, and only whitelisted storage keys
  are ever written.
- Size limits: at most 4096 characters, 80 lines and 200 characters per line.
  A key is `[a-z][a-z0-9-]{0,39}` and a value is at most 120 characters.
- The first non-empty line must be the header. Every other line must be
  `key: value`, a `(note)` or blank. Anything else (free text) rejects the
  whole message, and no button is shown.
- Unknown keys are ignored, so newer versions stay forward compatible. Invalid
  values are skipped, and numbers are clamped to their range. If a key repeats,
  the first valid value wins. The message must contain at least one valid
  setting.
- The button only appears in the Saved Messages chat, on your own message,
  and not on forwarded messages or saved copies. The handler checks the chat
  kind again.

## Apply

The confirm lists only the settings that differ, plus a note about any
skipped invalid or unknown keys. Apply writes localStorage and then refreshes
the UI live: theme, interface scale, chat appearance, bottom bar and chat
categories. It also pushes `media_quality`, `download_limit` and
`mdns_enabled` to core and rebuilds the drawer. If nothing differs, a toast
says "This device already uses these settings".

Trade-off: `notifications: on` only writes the preference. It doesn't trigger
the browser or OS permission prompt, which needs a user gesture on that
switch. If permission is missing, turn the switch off and on once in
Notifications.
