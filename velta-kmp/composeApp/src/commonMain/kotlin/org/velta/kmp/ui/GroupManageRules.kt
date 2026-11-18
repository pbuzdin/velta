package org.velta.kmp.ui

import org.velta.kmp.core.Contact

/**
 * Group management (#334 step 11): rename, who may be removed, who may
 * be added. Core `set_chat_name` rejects an empty name; self (contact 1)
 * leaves via Leave, not Remove.
 */

/** Drop control characters and trim. Null when nothing is left. */
fun groupName(raw: String): String? {
    val name = raw.filter { it.code !in 0..0x1f && it.code != 0x7f }.trim()
    return name.ifEmpty { null }
}

/** Groups and channels can be renamed. 1:1 names come from the contact. */
fun canRename(kind: String): Boolean = kind == "group" || kind == "channel"

/** #312: only an owned outgoing channel offers Invite via link/QR. */
fun offersChannelInvite(chatType: String?): Boolean = chatType == "OutBroadcast"

/** admin-group.js: only someone who can add members may remove, and not self. */
fun canRemoveMember(chat: MenuChat, contactId: Long): Boolean =
    chat.kind == "group" && canAddMembers(chat) && contactId > 1L

/** Contacts not already in the chat, and not self. */
fun contactsToAdd(contacts: List<Contact>, memberIds: Set<Long>): List<Contact> =
    contacts.filter { it.id > 1L && it.id !in memberIds }
