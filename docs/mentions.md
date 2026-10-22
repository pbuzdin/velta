# @mentions

Names + fingerprint code, no core changes. Code: `app/js/mentions.js`
(parser, own-mention check, composer picker), `app/js/markdown.js` (chips),
`app/js/chat-view.js` (member list, picker wiring), `app/js/notify-policy.js`
+ `app/js/app.js` (desktop/PWA notify gate), `velta-app/src-tauri/src/lib.rs`
(`text_mentions_name`, Android background notifications). Tests:
`tests/mentions.test.mjs`; contrast scenarios `mentions` / `mention-picker`
in `scripts/e2e-contrast.mjs`.

## Wire format

Plain text, so Delta Chat and every other client shows it as typed:

    @Ada Byron (C0FE) can you bring the tent?

`C0FE` is the first 4-hex group of the member's OpenPGP fingerprint,
uppercase, as Delta Chat displays fingerprints. Members without a real key
(fingerprint only derived) get a plain `@Name`. Typed `@Name` (no code) is
still a mention.

Fingerprints come from the existing core API, the same path the avatar
tiles use (`avatar.js fingerprintFor`): `get_contact_encryption_info` per
contact, and `make_vcard([1])` for our own key. Cached per (account,
contact).

## Composer

Typing `@` at the start of a word in a group or channel opens a listbox
above the composer (`#mention-picker`, `role=listbox`, the textarea carries
`aria-activedescendant`): avatars, names, codes; filters as you type
(prefix, then word prefix, then substring; diacritics-insensitive; self
excluded). Up/Down move, Enter/Tab insert, Escape or blur close. Tap keeps
the keyboard open (pointerdown is cancelled). 1:1 chats have no member list,
so no picker. The picker takes keys before the "/" commands popup and before
Enter-to-send.

## Matching (rendering + own mention)

At each `@` that starts a word (not after a letter/digit or `. @ + - % & / :
#`, so `a@b.c` is never a mention):

1. `@<text> (XXXX)`: the member whose code is XXXX. Works after renames and
   for duplicate names. If several members share the code: the one whose
   name equals `<text>`. A code that matches nobody still resolves to a
   same-named member only if that member has no known code (no key yet);
   a member whose code differs is someone else.
2. Otherwise the longest member name that follows (case-insensitive, word
   boundary after it; names with spaces and emoji work). Duplicate plain
   names resolve to the first member.

Chips show the member's *current* name plus the code small and regular
weight (same colour, no opacity, so AA holds); the parentheses are visually
hidden, so copy/paste and screen readers get `@Name (C0FE)`. `title` has
the full name + code. Mentions of me get a tinted, underlined, bolder chip.
Colours come from the link tokens (`--accent-text-in`, `--out-link`, brutal
ink). Links, e-mail addresses, emphasis and quotes are untouched (mentions
are scanned only in plain text between links/e-mails, like hashtags).

## Notifications

Muted chats stay silent, except an incoming message that mentions me, when
the drawer switch **Notify me when mentioned in muted chats** is on
(default on; `velta-notify-muted-mentions`, pushed to the shell as
`mentions_in_muted`).

- Desktop (Tauri) and PWA tab: `app.js` incoming-msg handler →
  `mutedChatAllows` + `mentionsMe` (name **and** own fingerprint code). Before
  this feature the page path did not gate muted chats at all; it does now.
- Android: the Rust background poller (`bg_notify_incoming`) posts the
  card. For a muted chat it reads `displayname` and checks
  `text_mentions_name`: **name only**, no code check (a duplicate-named
  member mentioned by code may notify too; a renamed me mentioned by code
  does not).
- PWA Web Push: a push only wakes the worker; the message is decided by the
  page path above once the core in the tab has fetched it. A closed tab can
  show no mention-specific notification.

## Limits

- Display names are not unique; without a code (typed `@Name`, contacts
  without a key) matching is by name.
- 4 hex digits = 65 536 values: collisions within one chat are possible and
  handled (name + code, then name), not prevented.
- Only the open chat's members are known for chips; quotes/notifications
  of other chats use the own-mention check only.
- Delta Chat shows the raw text, code included, and does not notify.

## Future: exact fingerprint mentions

A robust version would carry the mentioned fingerprints in a message header
(e.g. `Chat-Mentions: <fpr>,…`) next to the plain text, read on receive and
exposed in the message JSON. That needs a core patch (MIME builder +
receive_imf + jsonrpc type) via `tools/apply-core-patches.py`, ideally
upstreamed so Delta Chat can notify too. The text format above would stay as
the fallback.
