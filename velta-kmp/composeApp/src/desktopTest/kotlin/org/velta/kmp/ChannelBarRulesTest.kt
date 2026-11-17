package org.velta.kmp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.velta.kmp.ui.ChannelBarRules

/** Read-only channel bar: which channels replace the composer with the
 *  search / author / mute bar (2026-11-17 user design). */
class ChannelBarRulesTest {

    @Test
    fun `channel types only`() {
        assertTrue(ChannelBarRules.isChannel("InBroadcast"))
        assertTrue(ChannelBarRules.isChannel("OutBroadcast"))
        assertFalse(ChannelBarRules.isChannel("Single"))
        assertFalse(ChannelBarRules.isChannel("Group"))
        assertFalse(ChannelBarRules.isChannel("Mailinglist"))
        assertFalse(ChannelBarRules.isChannel(null))
    }

    @Test
    fun `bar shows for a channel without post rights, composer for owned channels`() {
        // Subscribed channel: rights check fails -> bar.
        assertTrue(ChannelBarRules.showBar("InBroadcast", canSend = false))
        // Owned channel: composer stays.
        assertFalse(ChannelBarRules.showBar("OutBroadcast", canSend = true))
        // Groups and 1:1 chats never get the bar, read-only or not.
        assertFalse(ChannelBarRules.showBar("Group", canSend = false))
        assertFalse(ChannelBarRules.showBar("Single", canSend = false))
        // Unknown type: no bar (rights check missing = don't guess).
        assertFalse(ChannelBarRules.showBar(null, canSend = false))
    }

    @Test
    fun `contact-author button needs exactly one contact`() {
        assertTrue(ChannelBarRules.showAuthorButton(1))
        assertFalse(ChannelBarRules.showAuthorButton(0), "unresolvable author: omit, don't guess")
        assertFalse(ChannelBarRules.showAuthorButton(2), "multiple contacts: not one author")
    }
}
