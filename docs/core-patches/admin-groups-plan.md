# Core patch plan: admin groups (port from ArcaneChat)

Status: shipped in v1.4.88 (#177; phases 1–4a and the admin chip done, 4b manual device interop and multiple admins still open). Target: vendored chatmail core 2.66.0 via `tools/apply-core-patches.py` (quilt patch #19, VENDORISSUES.MD §19).

## Checklist
- [x] Phase 1: core port as quilt #19 (46 ops) + Rust tests (`test_velta_*`), verify / tree-check / self-test green
- [x] Phase 2: jsonrpc + JS bindings (`create_group_with_admin`, `FullChat.groupAdminId`; rpc-core `createChat(…, "admin-group")`, `getGroupAdminId`, `removeChatMember`). The app calls JSON-RPC by name, so no TS bindings needed regenerating.
- [x] Phase 3: UI + strings (en/ru/fr) + JS tests (`app/js/admin-group.js`, `tests/admin-groups.test.mjs`). Screenshots: /workspace/drawer-icons/admin-groups-*.png (light/dark/brutal). Contrast measured in-page: badge 5.1 / 6.5 / 5.9:1, hint 5.6 / 5.2 / 5.5:1 (light / dark / brutal)
- [x] Phase 4a: stock Delta Chat interop (core-level simulation, see "Mixed clients")
- [ ] Phase 4b: manual device interop (Velta ↔ ArcaneChat Android, stock DC app)
- [ ] Multiple admins: not implemented. The grpid encodes exactly one admin (the creator), and ArcaneChat would ignore a new `Chat-Group-Admins` header, so this needs a format agreed with ArcaneChat (see Open questions)

## Goal
Groups where one admin (the creator) can't be kicked by regular members and is the only one who can change membership and group state. Wire-compatible with ArcaneChat.

## Source: three ArcaneChat core commits
| Commit | What it changes |
|---|---|
| [c9b9666 "add group with admin"](https://github.com/ArcaneChat/core/commit/c9b9666583b991f09e0408bda48fcc3e22923933) (+277/−23, 9 files) | Admin group ID = `ADMINFINGERPRINT:randomid` (`ADMIN_GROUP_ID_SEPARATOR = ':'`, `admin_group_fingerprint()`, `admin_group_base_id()`, `create_group_with_admin()`, `get_admin_contact_id()` in `chat.rs`); `validate_group_id()` in `tools.rs`; receive checks in `receive_imf.rs`; ephemeral-timer check in `ephemeral.rs`; QR `z=` param in `qr.rs`; securejoin admin-only add in `securejoin.rs`; `mimeparser.rs` uses the new validator; jsonrpc API. |
| [a2683e9 "allow admins to remove messages from others"](https://github.com/ArcaneChat/core/commit/a2683e9) (`message.rs`, `receive_imf.rs`, +8/−3) | Admin may delete-for-everyone other members' messages. |
| [9aa16dc "ignore pinned messages changes from non-admins"](https://github.com/ArcaneChat/core/commit/9aa16dc) (`receive_imf.rs`, 1 line) | Pin changes from non-admins are ignored. |

Merged as ArcaneChat/core PR #438 ([1178cd4](https://github.com/ArcaneChat/core/commit/1178cd432823dc0f584a3e52f34c9610b2024098)), Jul 2026; 9aa16dc Oct 2026.

## Mapping onto `apply-core-patches.py` ops
New VENDORISSUES entry (next free number, "admin groups"). One op per hunk; marker = a unique string in the inserted text (e.g. `ADMIN_GROUP_ID_SEPARATOR`, `is_group_admin_contact`).

| File | Ops (approx.) | Anchor | Risk |
|---|---|---|---|
| `core/src/chat.rs` | 2–3 (consts+helpers after imports; `create_group_with_admin` + `get_admin_contact_id` near `create_group`) | `pub async fn create_group` signature, module top | Low |
| `core/src/tools.rs` | 1 (`validate_group_id` after `validate_id`) | `fn validate_id` body end | Low |
| `core/src/mimeparser.rs` | 1 replace (`validate_id` → `validate_group_id` for grpid) | the grpid validation line | Low–Med |
| `core/src/qr.rs` | 1–2 (`z=` decode, grpid rebuild) | `decode_name(&param, "g")` area | Med |
| `core/src/securejoin.rs` | 2 (invite base id; admin-only add in vc-request handling) | group invite build + member-add branch | Med |
| `core/src/ephemeral.rs` | 1 | timer-change acceptance | Low |
| `core/src/receive_imf.rs` | ~8–10 (member removal, add, name/description/avatar, timer, pins, deletion, group creation, `is_group_admin_contact` fn) | many mid-function lines | **High**: hot file, changes every release |
| `core/src/message.rs` | 1 (delete-for-everyone permission) | `delete_msgs_ex` check | Low–Med |
| `core/deltachat-jsonrpc/src/api.rs`, `.../types/chat.rs` | 2–3 | `create_group_chat`, `FullChat` struct/ctor | Low |

Before writing ops: try `git apply` of the three commits onto `core/` in a scratch tree to see which hunks need porting by hand.

## Receive-side enforcement (on admin groups only)
Admin = contact whose key fingerprint equals the fingerprint prefix of the grpid.
- `Chat-Group-Member-Removed`: accept only from admin, or a member removing themselves (leave).
- `Chat-Group-Member-Added` and securejoin adds: admin only (non-admin inviter aborts securejoin).
- Name, description, avatar, ephemeral timer, pins: non-admin changes trashed/ignored.
- Delete-for-everyone of someone else's message: admin only.
- Group creation with an admin grpid by a non-admin: ignored.
Ordinary groups: unchanged upstream behaviour.

## jsonrpc API additions
- `create_group_with_admin(account_id, name) -> chat_id`
- `FullChat.group_admin_id: Option<u32>` (contact id of admin, `null` for regular groups)
- Regenerate TS bindings for the Velta app.

## UI changes
- New-group screen: "Admin group" toggle.
- Member list: admin badge.
- Non-admins: hide remove member, add member / QR invite, edit name/avatar/description, timer, pin.
- Admin: "Delete for everyone" on any message.
- Chat info line: "Moderated group · admin: X".

| Key | en | ru | fr |
|---|---|---|---|
| `admin_group_toggle` | Admin group | Группа с администратором | Groupe avec administrateur |
| `admin_group_toggle_hint` | Only you can add or remove members and edit the group. Protection works only in Velta and ArcaneChat. | Только вы сможете добавлять и удалять участников и редактировать группу. Защита работает только в Velta и ArcaneChat. | Vous seul pourrez ajouter ou retirer des membres et modifier le groupe. La protection ne fonctionne que dans Velta et ArcaneChat. |
| `admin_badge` | Admin | Админ | Admin |
| `admin_group_info` | Moderated group · admin: %1$s | Модерируемая группа · админ: %1$s | Groupe modéré · admin : %1$s |
| `admin_only_action` | Only the group admin can do this | Это может сделать только администратор группы | Seul l'administrateur du groupe peut faire cela |

## Mixed clients
- Velta ↔ ArcaneChat: same grpid format and rules; compatible.
- Stock Delta Chat / older clients — **verified 2026-10-29** on stock core 2.66.0 (a scratch test: an Alice group whose grpid was rewritten to `FPR:base`, received by an unpatched Bob; test not committed):
  - Stock `validate_id` rejects the `:` grpid, so the Chat-Group-ID is ignored. Bob gets an **ad-hoc group** ("Moderated", 3 members, `grpid=""`, address contacts). Later admin messages land in the same ad-hoc chat (matched by members and subject, not by ID).
  - Bob **cannot reply**: the ad-hoc group has no keys, so on a chatmail relay the send fails ("requires end-to-end encryption", `Failed to create send jobs`). On a classic e-mail server it would go out unencrypted, without the group ID, and the Velta side would put it in a separate ad-hoc chat.
  - Bob's "remove member" only changes his own ad-hoc chat. Nothing reaches the admin group.
  - Bob scanning an admin-group invite (`x=<base>&z=<name>`, no `g=`): stock `check_qr` sees a **contact** invite (`AskVerifyContact`), so it verifies the admin contact and joins nothing.
  - Net effect: stock clients can't take part in admin groups. They neither break the group nor bypass the admin. The UI hint says that protection (and membership) works only in Velta and ArcaneChat.
- Enforcement is per-device; a stock client can still locally "kick", only its own view changes.

## Test plan
- Core unit tests (port ArcaneChat's if any; add): non-admin removal ignored; self-leave accepted; admin removal accepted; non-admin name/avatar/description/timer/pin ignored; non-admin delete-for-everyone ignored; admin delete works; spoofed creation ignored; QR round-trip with `z=`; securejoin via non-admin aborted; `validate_group_id` cases.
- `apply-core-patches.py verify` + `tree-check --fetch` + `self-test`.
- Interop (manual): Velta admin ↔ ArcaneChat Android member and vice versa.
- Stock Delta Chat (current release): join/receive in admin group, record how the chat appears, whether its kick/rename reaches Velta and is ignored.

## Re-vendor risk
`receive_imf.rs` ops are the fragile part: upstream refactors break anchors every few releases. Mitigation: smallest anchors, one op per check, tests that fail loudly if a check is lost. If upstream ships its own roles, drop this patch and migrate.

## Phased estimate
1. Core port + ops + unit tests: 3–5 days
2. jsonrpc + bindings: 0.5 day
3. UI + strings: 2–3 days
4. Interop testing (ArcaneChat, stock Delta Chat): 1–2 days
Total ≈ 6–10 days.

## Open questions
- Multiple admins / admin transfer: would need a new header (e.g. `Chat-Group-Admins`); ArcaneChat would ignore it → Velta-only, breaks parity. Defer unless ArcaneChat agrees on a format.
- ArcaneChat desktop: not checked whether it supports admin groups.
- Exact stock Delta Chat behaviour (see test).
- Whether upstream chatmail plans roles (none found as of Oct 2026).

## As built (UI, #177)
- New group → name dialog: an "Admin group" switch (outline shield icon) with the hint string.
- Chat info: "Moderated group · admin: X" line under the name; an Admin badge on the admin's member row.
- Admin: Remove on every other member. Velta's relay-group sheet had no Remove before, so regular groups still have none.
- Non-admin: the Edit group, Add members, and Invite via link/QR buttons are hidden, and so is "Group invite QR" in the chat menu. The disappearing-messages row is shown but inert (`aria-disabled`, with the title "Only the group admin can do this"). Pin, Unpin, and the pinned-bar unpin are hidden.
- Delete for everyone: the admin also gets it on others' messages. Everyone keeps it for their own messages.
- Leaving stays possible for everyone, the admin included. Nothing hands the group over, so if the admin leaves, the group is frozen.
- PWA: the wasm series still applies on top of quilt #19 (`apply-wasm-core-patches.py apply-on-copy` OK), so the PWA gets the same core code. The wasm build itself was not compiled in this run.
- Admin chip (88c1620): the admin's messages show an "Admin" chip in the sender line (after the bot chip), added to already-rendered rows when `groupAdminId` arrives late. Strings en/ru/fr; mock demo `?mockadmin=`.
- Released in v1.4.88 (core 156441d, bindings d3d4c40, UI 92b5be9, chip 88c1620).
