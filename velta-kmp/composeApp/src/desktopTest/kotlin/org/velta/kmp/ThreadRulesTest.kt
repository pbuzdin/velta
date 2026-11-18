package org.velta.kmp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.velta.kmp.core.MessageObject
import org.velta.kmp.core.MessageQuote
import org.velta.kmp.ui.replyCountFor
import org.velta.kmp.ui.replyRpcMissing
import org.velta.kmp.ui.sendQuotePlan
import org.velta.kmp.ui.threadOrigLine
import org.velta.kmp.ui.threadRows
import org.velta.kmp.ui.windowReplyCounts

/** Stable reply-count and thread-panel rules (chat-view.js, docs/reply-threads.md). */
class ThreadRulesTest {

    private fun msg(id: Long, quote: Long? = null, text: String = "", ts: Long = id) = MessageObject(
        id = id,
        text = text,
        timestamp = ts,
        quote = quote?.let { MessageQuote(kind = "WithMessage", messageId = it, text = "q") },
    )

    @Test
    fun windowCountsQuotesAndSkipsBareText() {
        val bare = MessageObject(id = 6, quote = MessageQuote(kind = "JustText", text = "only text"))
        val counts = windowReplyCounts(listOf(
            msg(1, text = "parent"),
            msg(2, quote = 1),
            msg(3),
            msg(4, quote = 1),
            msg(5, quote = 2),
            bare,
        ))
        assertEquals(mapOf(1L to 2, 2L to 1), counts)
    }

    @Test
    fun countUsesCoreUnlessTheWindowIsAhead() {
        val window = mapOf(1L to 2)
        assertEquals(5, replyCountFor(1, window, mapOf(1L to 5), hasMore = true))
        assertEquals(3, replyCountFor(1, mapOf(1L to 3), mapOf(1L to 1), hasMore = false))
        assertEquals(0, replyCountFor(1, window, null, hasMore = true))
        assertEquals(2, replyCountFor(1, window, null, hasMore = false))
        assertEquals(0, replyCountFor(9, window, emptyMap(), hasMore = true))
    }

    @Test
    fun threadIsParentThenRepliesOldestFirst() {
        val loaded = listOf(msg(1, text = "p"), msg(3, quote = 1, ts = 30))
        val extras = listOf(msg(2, quote = 1, ts = 20), msg(3, quote = 1, ts = 99))
        assertEquals(listOf(1L, 2L, 3L), threadRows(loaded, extras, 1).map { it.id })
        val offWindow = listOf(msg(2, quote = 9, ts = 2), msg(3, quote = 9, ts = 3))
        assertEquals(listOf(2L, 3L), threadRows(emptyList(), offWindow, 9).map { it.id })
    }

    @Test
    fun sendKeepsTheBarOnTheParent() {
        assertEquals(9L to 7L, sendQuotePlan(7, 9))
        assertEquals(7L to 7L, sendQuotePlan(7, 7))
        assertEquals(9L to null, sendQuotePlan(null, 9))
    }

    @Test
    fun missingReplyRpcIsPermanent() {
        assertTrue(replyRpcMissing(IllegalStateException("get_reply_counts failed (-32601): Method not found")))
        assertFalse(replyRpcMissing(IllegalStateException("timeout")))
    }

    @Test
    fun origLineIsNameAndFirstLine() {
        assertEquals("Ada: hello", threadOrigLine("Ada", "hello\nmore", null))
        assertEquals("pic.png", threadOrigLine("", "", "pic.png"))
    }
}
