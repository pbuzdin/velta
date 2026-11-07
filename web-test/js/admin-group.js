// Admin groups (#177, core quilt #19 — port of ArcaneChat's "group with
// admin"). The group ID is `ADMINFINGERPRINT:randomid`; the core exposes the
// admin as FullChat.groupAdminId (contact id, 1 = this account, null for
// regular groups). Every receiving core enforces the rules; this module only
// decides which controls the UI shows, so a non-admin never sees an action
// that the cores would refuse or ignore.
import { ICON } from "./icons.js";
import { escapeHtml } from "./format.js";
import { t } from "./i18n.js";

export const SELF_ID = 1;

/** True when the chat is an admin group (groupAdminId known). */
export function isAdminGroup(chat) {
  return !!chat && chat.kind === "group" && Number.isInteger(chat.groupAdminId) && chat.groupAdminId > 0;
}

/** True when this account administers the chat. */
export function selfIsAdmin(chat) {
  return isAdminGroup(chat) && chat.groupAdminId === SELF_ID;
}

/**
 * What this account may do in a group. Regular groups and other chats keep
 * the stock Delta Chat rules (every member may edit), so everything is true
 * except removing others, which Velta's relay-group sheet never offered.
 */
export function adminCaps(chat) {
  const admin = isAdminGroup(chat);
  const me = selfIsAdmin(chat);
  const may = !admin || me;
  return {
    isAdminGroup: admin,
    isAdmin: me,
    canEditGroup: may,       // name, avatar, description
    canAddMembers: may,      // picker and invite link/QR
    canSetTimer: may,        // disappearing messages
    canPin: may,             // pin / unpin for everyone
    canRemoveOthers: admin && me,
    /** Delete for everyone: own messages always; others' only as admin. */
    canDeleteForAll: (fromId) => fromId === SELF_ID || (admin && me),
  };
}

/** May this account remove the member `m` (row action)? */
export function canRemoveMember(chat, m) {
  const id = m?.id;
  return selfIsAdmin(chat) && id !== SELF_ID && !m?.self && id !== chat.groupAdminId;
}

/** Badge shown next to the admin's name in member lists. */
export function adminBadgeHtml() {
  const label = t("Admin");
  return `<span class="admin-badge" title="${escapeHtml(label)}">${ICON.shieldCheck}<span>${escapeHtml(label)}</span></span>`;
}

/** Message-meta chip on the group admin's messages (styled like .bot-chip). */
export function adminChipHtml() {
  const label = t("Group admin");
  return `<span class="admin-chip" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${ICON.shield}<span aria-hidden="true">${escapeHtml(t("admin"))}</span></span>`;
}

/** "Moderated group · admin: X" info line, or "" for regular groups. */
export function adminInfoText(chat, adminName) {
  if (!isAdminGroup(chat)) return "";
  const name = chat.groupAdminId === SELF_ID ? t("you") : (adminName || "?");
  return t("Moderated group · admin: {name}", { name });
}
