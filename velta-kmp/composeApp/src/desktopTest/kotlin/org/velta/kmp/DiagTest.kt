package org.velta.kmp

import org.velta.kmp.core.Diag
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** #516: the diagnostics ring buffer — cap, order, clear. */
class DiagTest {

    @AfterTest
    fun cleanup() {
        Diag.clear()
        Diag.clockSeconds = { 0L }
    }

    @Test
    fun ringKeepsTheNewestMaxEntriesInOrder() {
        var now = 1_000L
        Diag.clockSeconds = { now }
        val before = Diag.version
        repeat(Diag.MAX + 5) { n ->
            now = 1_000L + n
            Diag.w("line $n")
        }
        val entries = Diag.snapshot()
        assertEquals(Diag.MAX, entries.size, "the ring is capped")
        assertEquals("line 5", entries.first().text, "the oldest entries drop out")
        assertEquals("line ${Diag.MAX + 4}", entries.last().text, "oldest first")
        assertEquals(1_000L + Diag.MAX + 4, entries.last().atSeconds, "entries carry the injected clock")
        assertTrue(Diag.version > before, "version bumps so an open screen recomposes")
    }

    @Test
    fun clearEmptiesTheBuffer() {
        Diag.w("x")
        assertTrue(Diag.snapshot().isNotEmpty())
        Diag.clear()
        assertTrue(Diag.snapshot().isEmpty())
    }
}
