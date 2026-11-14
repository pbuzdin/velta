package org.velta.kmp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.velta.kmp.core.ChatListItem
import org.velta.kmp.ui.chatCategoryOf
import org.velta.kmp.ui.chatIsUnread
import org.velta.kmp.ui.chatKindOf
import org.velta.kmp.ui.listPreview
import org.velta.kmp.ui.summaryStateOf

/**
 * Pure vectors for the #57 category bar port (web rpc-core.js chatCategoryOf /
 * _chatKind / _mapChatListItem). ChatListItem defaults carry the wire's
 * PascalCase chatType ("Single"/"Group"/"Mailinglist"/…).
 */
class ChatCategoryTest {

    private fun item(
        chatType: String? = "Single",
        isSelfTalk: Boolean = false,
        isDeviceTalk: Boolean = false,
        isContactRequest: Boolean = false,
        dmChatContact: Long? = null,
    ) = ChatListItem(
        chatType = chatType,
        isSelfTalk = isSelfTalk,
        isDeviceTalk = isDeviceTalk,
        isContactRequest = isContactRequest,
        dmChatContact = dmChatContact,
    )

    @Test
    fun chatKindVectors() {
        assertEquals("saved", chatKindOf(item(isSelfTalk = true)))
        assertEquals("device", chatKindOf(item(isDeviceTalk = true)))
        assertEquals("deaddrop", chatKindOf(item(isContactRequest = true)))
        assertEquals("group", chatKindOf(item(chatType = "Group")))
        assertEquals("channel", chatKindOf(item(chatType = "Mailinglist")))
        assertEquals("channel", chatKindOf(item(chatType = "OutBroadcast")))
        assertEquals("channel", chatKindOf(item(chatType = "InBroadcast")))
        assertEquals("single", chatKindOf(item()))
    }

    @Test
    fun categoryVectors() {
        val noBots: (Long) -> Boolean = { false }
        val bots: (Long) -> Boolean = { it == 42L }
        assertEquals("system", chatCategoryOf(item(isSelfTalk = true), noBots))
        assertEquals("system", chatCategoryOf(item(isDeviceTalk = true), noBots))
        assertEquals("system", chatCategoryOf(item(isContactRequest = true), noBots))
        assertEquals("groups", chatCategoryOf(item(chatType = "Group"), noBots))
        assertEquals("channels", chatCategoryOf(item(chatType = "Mailinglist"), noBots))
        assertEquals("people", chatCategoryOf(item(dmChatContact = 7), bots))
        assertEquals("bots", chatCategoryOf(item(dmChatContact = 42), bots))
        // Unknown contact (no dm id) counts as people — the safe default.
        assertEquals("people", chatCategoryOf(item(dmChatContact = null), bots))
    }

    @Test
    fun unreadIsAFilterNotABucket() {
        assertTrue(chatIsUnread(ChatListItem(freshMessageCounter = 3)))
        assertFalse(chatIsUnread(ChatListItem(freshMessageCounter = 0)))
    }

    @Test
    fun summaryStateVectors() {
        // Outgoing window 18..28 (web _mapState).
        assertEquals("pending", summaryStateOf(18))
        assertEquals("pending", summaryStateOf(19))
        assertEquals("pending", summaryStateOf(20))
        assertEquals("failed", summaryStateOf(24))
        assertEquals("delivered", summaryStateOf(26))
        assertEquals("read", summaryStateOf(28))
        // Incoming states never render a tick.
        assertEquals("received", summaryStateOf(10))
        assertEquals("received", summaryStateOf(16))
    }

    @Test
    fun previewMediaPrefixes() {
        assertEquals(
            "a: b",
            listPreview(ChatListItem(summaryText1 = "a", summaryText2 = "b")),
        )
        // Core's summaryText2 already embeds the media emoji (summary.rs
        // get_summary_text_ext, add_type_emoji) — pass through unchanged;
        // a re-prefix showed one received photo as "📷 📷 caption".
        assertEquals("📷 help", listPreview(ChatListItem(lastMessageType = "Image", summaryText2 = "📷 help")))
        assertEquals("📷 Image", listPreview(ChatListItem(lastMessageType = "Image", summaryText2 = "📷 Image")))
        assertEquals("caption", listPreview(ChatListItem(lastMessageType = "Gif", summaryText2 = "caption")))
        assertEquals("doc.pdf", listPreview(ChatListItem(lastMessageType = "File", summaryText2 = "doc.pdf")))
        assertEquals("sticker", listPreview(ChatListItem(lastMessageType = "Sticker", summaryText2 = "sticker")))
        // Empty media summaries fall back to the web's defaults (with emoji).
        assertEquals("📷 Photo", listPreview(ChatListItem(lastMessageType = "Image", summaryText2 = "")))
        assertEquals("🎤 Voice message", listPreview(ChatListItem(lastMessageType = "Voice")))
        assertEquals("🎬 Video", listPreview(ChatListItem(lastMessageType = "Video")))
        assertEquals("📎 File", listPreview(ChatListItem(lastMessageType = "File")))
    }
}
