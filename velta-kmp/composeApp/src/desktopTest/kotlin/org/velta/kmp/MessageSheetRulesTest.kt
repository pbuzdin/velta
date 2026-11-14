package org.velta.kmp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import org.velta.kmp.core.MessageObject
import org.velta.kmp.ui.DeleteChoice
import org.velta.kmp.ui.ReactionChip
import org.velta.kmp.ui.SHEET_REACTIONS
import org.velta.kmp.ui.SheetAction
import org.velta.kmp.ui.SheetAction.*
import org.velta.kmp.ui.SheetChat
import org.velta.kmp.ui.SheetContext
import org.velta.kmp.ui.canDeleteForAll
import org.velta.kmp.ui.canEditMsg
import org.velta.kmp.ui.deleteConfirmChoices
import org.velta.kmp.ui.deletedMessageActions
import org.velta.kmp.ui.formatServerUrl
import org.velta.kmp.ui.messageInfoStateKeys
import org.velta.kmp.ui.messageSheetActions
import org.velta.kmp.ui.messageSheetRows
import org.velta.kmp.ui.myReaction
import org.velta.kmp.ui.reactionChips
import org.velta.kmp.ui.reactionToggle
import org.velta.kmp.ui.sheetLinks
import org.velta.kmp.ui.sheetOrder
import org.velta.kmp.ui.shownReactions
import org.velta.kmp.ui.stripTrackingUrl

/**
 * #334 step 5: the phone message sheet rules, vectors taken from stable
 * (chat-view.js _msgContextMenu, ui.js messageSheetRows /
 * deleteConfirmChoices / buildReactionRow, reactions.js, msg-edit.js,
 * admin-group.js, trackers.js, format.js).
 */
class MessageSheetRulesTest {

    private fun msg(
        fromId: Long = 2,
        viewType: String = "Text",
        text: String = "hello",
        file: String? = null,
        downloadState: String? = "Done",
        isPinned: Boolean = false,
        hasHtml: Boolean = false,
        isInfo: Boolean = false,
        state: Int = 16,
        showPadlock: Boolean = true,
    ) = MessageObject(
        id = 42, chatId = 10, fromId = fromId, text = text, viewType = viewType, file = file,
        downloadState = downloadState, isPinned = isPinned, hasHtml = hasHtml, isInfo = isInfo,
        state = state, showPadlock = showPadlock,
    )

    private fun sheet(m: MessageObject, ctx: SheetContext = SheetContext()) = sheetOrder(messageSheetActions(m, ctx))

    @Test
    fun incomingTextSheetMatchesStableOrder() {
        // Buckets send, keep, file, own, text, meta, then the tail (Delete).
        assertEquals(
            listOf(Reply, Forward, Pin, SaveToSaved, CopyText, SelectText, Select, Info, Delete),
            sheet(msg()),
        )
    }

    @Test
    fun ownTextAddsEditAndResend() {
        assertEquals(
            listOf(Reply, Forward, Pin, SaveToSaved, Edit, Resend, CopyText, SelectText, Select, Info, Delete),
            sheet(msg(fromId = 1)),
        )
    }

    @Test
    fun linkPressPutsLinkActionsInTheTextBucket() {
        val items = sheet(msg(text = "see https://example.com"), SheetContext(linkHref = "https://example.com"))
        assertEquals(
            listOf(Reply, Forward, Pin, SaveToSaved, CopyLink, ShareLink, OpenLink, CopyText, SelectText, Select, Info, Delete),
            items,
        )
        // No share target → no Share link; non-http hrefs give no link items.
        assertFalse(ShareLink in sheet(msg(), SheetContext(linkHref = "https://a.b", canShareLink = false)))
        assertFalse(CopyLink in sheet(msg(), SheetContext(linkHref = "mailto:x@y.z")))
    }

    @Test
    fun readOnlyChatsHideReplyAndPin() {
        val items = sheet(msg(), SheetContext(chat = SheetChat(readOnly = true)))
        assertFalse(Reply in items)
        assertFalse(Pin in items)
        assertTrue(Forward in items)
    }

    @Test
    fun pinFollowsAdminCapsAndPinnedState() {
        assertTrue(Unpin in sheet(msg(isPinned = true)))
        // Admin group where someone else is admin: no pin.
        val notAdmin = SheetChat(isGroup = true, groupAdminId = 7)
        assertFalse(Pin in sheet(msg(), SheetContext(chat = notAdmin)))
        assertTrue(Pin in sheet(msg(), SheetContext(chat = SheetChat(isGroup = true, groupAdminId = 1))))
    }

    @Test
    fun mediaGetsDownloadStickerGetsSave() {
        val img = sheet(msg(viewType = "Image", text = "", file = "/b/p.jpg"))
        assertEquals(listOf(Reply, Forward, Pin, SaveToSaved, Download, Select, Info, Delete), img)
        // Not yet downloaded (no file, state Available): still offers Download.
        assertTrue(Download in sheet(msg(viewType = "File", text = "", file = null, downloadState = "Available")))
        assertFalse(Download in sheet(msg(viewType = "File", text = "", file = null)))
        // Gif maps to stable "image".
        assertTrue(Download in sheet(msg(viewType = "Gif", text = "", file = "/b/a.gif")))
        // Voice has no Download (stable: image/video/file only).
        assertFalse(Download in sheet(msg(viewType = "Voice", text = "", file = "/b/v.ogg")))
        // Stickers: Save sticker on received ones only.
        assertTrue(SaveSticker in sheet(msg(viewType = "Sticker", text = "", file = "/b/s.webp")))
        assertFalse(SaveSticker in sheet(msg(fromId = 1, viewType = "Sticker", text = "", file = "/b/s.webp")))
    }

    @Test
    fun copyTextOnlyForTextSelectTextForAnyCaption() {
        val captioned = sheet(msg(viewType = "Image", text = "caption", file = "/b/p.jpg"))
        assertFalse(CopyText in captioned)
        assertTrue(SelectText in captioned)
    }

    @Test
    fun showRepliesRidesTheTailBeforeDelete() {
        val items = sheet(msg(), SheetContext(replyCount = 2))
        assertEquals(listOf(ShowReplies, Delete), items.takeLast(2))
    }

    @Test
    fun infoMessagesGetNoSheetAndHeldDeletesGetThreeItems() {
        assertEquals(emptyList(), messageSheetActions(msg(isInfo = true), SheetContext()))
        assertEquals(listOf(Select, Info, Delete), sheetOrder(deletedMessageActions()))
    }

    @Test
    fun rowsSplitTilesFromDanger() {
        val (tiles, danger) = messageSheetRows(sheet(msg()))
        assertEquals(listOf(Delete), danger)
        assertFalse(tiles.any { it.danger })
        assertEquals("Copy", CopyText.caption)
        assertEquals("Save", SaveToSaved.caption)
        assertEquals("Sticker", SaveSticker.caption)
    }

    @Test
    fun editRulesMirrorMsgEdit() {
        assertTrue(canEditMsg(msg(fromId = 1)))
        assertFalse(canEditMsg(msg(fromId = 2)))
        assertFalse(canEditMsg(msg(fromId = 1, text = "  ")))
        assertFalse(canEditMsg(msg(fromId = 1, hasHtml = true)))
        assertFalse(canEditMsg(msg(fromId = 1, viewType = "Sticker")))
        assertFalse(canEditMsg(msg(fromId = 1, viewType = "Webxdc")))
        assertTrue(canEditMsg(msg(fromId = 1, viewType = "Image", text = "cap")))
    }

    @Test
    fun deleteForAllRules() {
        val chat = SheetChat()
        assertTrue(canDeleteForAll(chat, listOf(msg(fromId = 1))))
        assertFalse(canDeleteForAll(chat, listOf(msg(fromId = 2))))
        assertFalse(canDeleteForAll(chat, listOf(msg(fromId = 1), null)))
        assertFalse(canDeleteForAll(SheetChat(isSaved = true), listOf(msg(fromId = 1))))
        assertFalse(canDeleteForAll(SheetChat(isEncrypted = false), listOf(msg(fromId = 1))))
        // Admin of an admin group may delete others' messages for everyone.
        assertTrue(canDeleteForAll(SheetChat(isGroup = true, groupAdminId = 1), listOf(msg(fromId = 2))))
        assertEquals(listOf(DeleteChoice.Cancel, DeleteChoice.ForMe), deleteConfirmChoices(false))
        assertEquals(listOf(DeleteChoice.Cancel, DeleteChoice.ForMe, DeleteChoice.ForEveryone), deleteConfirmChoices(true))
    }

    @Test
    fun reactionRowAndToggle() {
        assertEquals(11, SHEET_REACTIONS.size)
        assertEquals(SHEET_REACTIONS, shownReactions(SHEET_REACTIONS, "👍"))
        val custom = shownReactions(SHEET_REACTIONS, "🦄")
        assertEquals(11, custom.size)
        assertEquals("🦄", custom.first())
        assertFalse("💯" in custom)

        val chips = listOf(ReactionChip("👍", 2, true), ReactionChip("❤️", 1, false))
        assertEquals("👍", myReaction(chips))
        val remove = reactionToggle(chips, "👍")
        assertEquals(emptyList(), remove.send)
        assertTrue(remove.removing)
        assertEquals(listOf(ReactionChip("👍", 1, false), ReactionChip("❤️", 1, false)), remove.chips)
        val replace = reactionToggle(chips, "❤️")
        assertEquals(listOf("❤️"), replace.send)
        assertEquals(listOf(ReactionChip("👍", 1, false), ReactionChip("❤️", 2, true)), replace.chips)
    }

    @Test
    fun reactionChipsParseCoreReactions() {
        val wire = Json.parseToJsonElement(
            """{"reactionsByContact":{"1":["👍"],"5":["👍"]},"reactions":[{"emoji":"👍","count":2,"isFromSelf":true}]}""",
        )
        assertEquals(listOf(ReactionChip("👍", 2, true)), reactionChips(wire))
        assertEquals(emptyList(), reactionChips(null))
    }

    @Test
    fun trackingStripMatchesTrackersJs() {
        assertEquals("https://a.com/p?x=1", stripTrackingUrl("https://a.com/p?x=1&utm_source=n&fbclid=z"))
        assertEquals("https://a.com/p", stripTrackingUrl("https://a.com/p?utm_medium=x"))
        // Host-limited names: kept elsewhere, stripped on their host.
        assertEquals("https://a.com/?s=1", stripTrackingUrl("https://a.com/?s=1"))
        assertEquals("https://x.com/u/status/1", stripTrackingUrl("https://x.com/u/status/1?s=20&t=abc"))
        assertEquals("https://youtu.be/id?t=5", stripTrackingUrl("https://youtu.be/id?t=5&si=xyz"))
        // Untouched: clean links, invite fragments, non-http.
        val invite = "https://i.delta.chat/?utm_source=x#0123456789ABCDEF0123456789ABCDEF01234567&a=b"
        assertEquals(invite, stripTrackingUrl(invite))
        assertEquals("mailto:a@b.c?utm_source=x", stripTrackingUrl("mailto:a@b.c?utm_source=x"))
        assertEquals("https://a.com/p?q=1#frag", stripTrackingUrl("https://a.com/p?q=1&gclid=2#frag"))
    }

    @Test
    fun showLinksListSkipsTheSinglePressedLink() {
        assertEquals(emptyList(), sheetLinks(listOf("https://a.com"), "https://a.com", strip = true))
        assertEquals(
            listOf("https://a.com", "https://b.com/x"),
            sheetLinks(listOf("https://a.com", "https://b.com/x?utm_source=q", "https://a.com"), "https://a.com", strip = true),
        )
    }

    @Test
    fun infoHelpers() {
        assertEquals("me@x.org UID=7", formatServerUrl("<me@x.org/INBOX/;UID=7>"))
        assertEquals("me@x.org DeltaChat UID=9", formatServerUrl("<me@x.org/DeltaChat/;UID=9>"))
        assertEquals("plain", formatServerUrl("plain"))
        assertEquals("Seen" to "Encrypted", messageInfoStateKeys(msg(state = 16)))
        assertEquals("Not seen" to "Not encrypted", messageInfoStateKeys(msg(state = 10, showPadlock = false)))
        assertEquals("Not seen" to "Encrypted", messageInfoStateKeys(msg(fromId = 1, state = 26)))
        assertEquals("Seen" to "Encrypted", messageInfoStateKeys(msg(fromId = 1, state = 28)))
    }

    @Test
    fun everySheetActionHasAnEnglishStableLabel() {
        val labels = SheetAction.entries.map { it.label }
        assertEquals(labels.toSet().size, labels.size)
        assertTrue(labels.all { it.isNotBlank() })
    }
}
