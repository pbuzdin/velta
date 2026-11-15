package org.velta.kmp

import org.velta.kmp.ui.MentionMember
import org.velta.kmp.ui.BARE_AT_MAX
import org.velta.kmp.ui.filterMembers
import org.velta.kmp.ui.fprCode
import org.velta.kmp.ui.mentionQuery
import org.velta.kmp.ui.mentionToken
import org.velta.kmp.ui.mentionsMe
import org.velta.kmp.ui.mutedChatAllows
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #323: picker query, token, and the muted-chat notify gate. */
class MentionsTest {
    private val members = listOf(
        MentionMember(1, "Me", "AAAA"),
        MentionMember(2, "Anna Lee", "B1B2"),
        MentionMember(3, "Boris", ""),
    )

    @Test
    fun queryAndFilterAndToken() {
        assertNull(mentionQuery("email me@host"))
        val q = mentionQuery("hey @an")
        assertEquals(4, q?.start)
        assertEquals("an", q?.query)
        assertEquals(listOf("Anna Lee"), filterMembers(members, "an").map { it.name })
        assertEquals("@Anna Lee (B1B2) ", mentionToken(members[1]))
        assertEquals("@Boris ", mentionToken(members[2]))
        assertTrue(filterMembers(members, "").size <= 8)
        assertTrue(BARE_AT_MAX == 10)
    }

    @Test
    fun mentionsMeAndMutedGate() {
        assertTrue(mentionsMe("hey @Me (AAAA)", "Me", "AAAA"))
        assertTrue(mentionsMe("hey @Someone (AAAA) there", "Other", "AAAA"))
        assertFalse(mentionsMe("hey @Boris", "Me", "AAAA"))
        assertTrue(mutedChatAllows(muted = true, mentioned = true, mentionInMuted = true))
        assertFalse(mutedChatAllows(muted = true, mentioned = true, mentionInMuted = false))
        assertFalse(mutedChatAllows(muted = true, mentioned = false))
        assertTrue(mutedChatAllows(muted = false, mentioned = false))
        assertEquals("ABCD", fprCode("ab cd" + "e".repeat(36)))
        assertEquals("", fprCode("abcd"))
    }
}
