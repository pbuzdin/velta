package org.velta.kmp

import org.velta.kmp.core.Contact
import org.velta.kmp.ui.MenuChat
import org.velta.kmp.ui.canRemoveMember
import org.velta.kmp.ui.canRename
import org.velta.kmp.ui.contactsToAdd
import org.velta.kmp.ui.groupName
import org.velta.kmp.ui.offersChannelInvite
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #334 step 11: rename / add / remove follow the core and admin-group.js. */
class GroupManageRulesTest {
    private fun group(adminId: Long? = null) = MenuChat(id = 3, name = "G", kind = "group", groupAdminId = adminId)

    @Test
    fun nameDropsControlsAndRejectsBlank() {
        assertEquals("Cafe", groupName("  Cafe\n"))
        assertNull(groupName("  \n"))
        assertNull(groupName(""))
    }

    @Test
    fun renameIsGroupsAndChannels() {
        assertTrue(canRename("group"))
        assertTrue(canRename("channel"))
        assertFalse(canRename("single"))
        assertTrue(offersChannelInvite("OutBroadcast"))
        assertFalse(offersChannelInvite("InBroadcast"))
        assertFalse(offersChannelInvite("Mailinglist"))
    }

    @Test
    fun removeSkipsSelfAndNonAdmins() {
        assertTrue(canRemoveMember(group(), 4))
        assertFalse(canRemoveMember(group(), 1))
        assertFalse(canRemoveMember(group(adminId = 9), 4))
        assertTrue(canRemoveMember(group(adminId = 1), 4))
        assertFalse(canRemoveMember(MenuChat(1, "A", "single"), 4))
    }

    @Test
    fun addSkipsSelfAndCurrentMembers() {
        val contacts = listOf(
            Contact(id = 1, displayName = "me"),
            Contact(id = 2, displayName = "ann"),
            Contact(id = 3, displayName = "bob"),
        )
        assertEquals(listOf(3L), contactsToAdd(contacts, setOf(2)).map { it.id })
    }
}
