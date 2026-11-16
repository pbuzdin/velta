package org.velta.kmp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.velta.kmp.core.MessageObject
import org.velta.kmp.ui.CardRow
import org.velta.kmp.ui.composerCardRows
import org.velta.kmp.ui.replySnippet
import org.velta.kmp.ui.replyThumbKind
import org.velta.kmp.ui.stagedDetail
import org.velta.kmp.ui.stagedKind

class ComposerCardRulesTest {
    @Test fun rowsCombineInOneCard() {
        assertEquals(emptyList(), composerCardRows(reply = false, editing = false, attachment = false))
        assertEquals(listOf(CardRow.Reply), composerCardRows(reply = true, editing = false, attachment = false))
        assertEquals(listOf(CardRow.Reply, CardRow.Attachment), composerCardRows(reply = true, editing = false, attachment = true))
        assertEquals(listOf(CardRow.Attachment), composerCardRows(reply = false, editing = false, attachment = true))
        // Editing takes the reply row's place.
        assertEquals(listOf(CardRow.Edit), composerCardRows(reply = true, editing = true, attachment = false))
    }

    @Test fun quotedMediaGetsAThumbnailOthersTheAvatar() {
        assertEquals("image", replyThumbKind(MessageObject(viewType = "Image", file = "/b/p.jpg")))
        assertEquals("image", replyThumbKind(MessageObject(viewType = "Sticker", file = "/b/s.webp")))
        assertEquals("video", replyThumbKind(MessageObject(viewType = "Video", file = "/b/v.mp4")))
        assertNull(replyThumbKind(MessageObject(viewType = "Image", file = null)))
        assertNull(replyThumbKind(MessageObject(viewType = "File", file = "/b/doc.pdf")))
        assertNull(replyThumbKind(MessageObject(viewType = "Text", text = "hi")))
    }

    @Test fun snippetPrefersTextThenFileNameThenLabel() {
        assertEquals("first line", replySnippet(MessageObject(text = "\n first line \nsecond")))
        assertEquals("x".repeat(80), replySnippet(MessageObject(text = "x".repeat(200))))
        assertEquals("report.pdf", replySnippet(MessageObject(viewType = "File", fileName = "report.pdf")))
        assertEquals("Photo", replySnippet(MessageObject(viewType = "Image")))
        assertEquals("Voice message", replySnippet(MessageObject(viewType = "Voice")))
        assertEquals("[Message]", replySnippet(MessageObject(viewType = "Webxdc")) { "[$it]" })
    }

    @Test fun stagedLabels() {
        assertEquals("image", stagedKind("IMG_1.JPG"))
        assertEquals("video", stagedKind("clip.mp4"))
        assertEquals("file", stagedKind("notes.txt"))
        assertEquals("Photo", stagedDetail("image", 0))
        assertEquals("Video · 0:42", stagedDetail("video", 42_000))
        assertEquals("Video", stagedDetail("video", 0))
        assertEquals("File", stagedDetail("file", 0))
    }
}
