package org.velta.kmp

import org.velta.kmp.ui.fmtXferSize
import org.velta.kmp.ui.looksLikeXferExplainer
import org.velta.kmp.ui.parseFileCard
import org.velta.kmp.ui.xferDisplayText
import org.velta.kmp.ui.xferVisibleText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class XferTextTest {
    // {"v":1,"hash":"cd"×32,"size":7000000,"name":"film.mp4"}
    private val ticket =
        "VXFER1:eyJ2IjoxLCJoYXNoIjoiY2RjZGNkY2RjZGNkY2RjZGNkY2RjZGNkY2RjZGNkY2RjZGNkY2RjZGNkY2RjZGNkY2RjZGNkY2RjZGNkY2RjZCIsInNpemUiOjcwMDAwMDAsIm5hbWUiOiJmaWxtLm1wNCJ9"

    @Test
    fun sizeFormatMatchesTheWeb() {
        assertEquals("6.7 MB", fmtXferSize(7_000_000))
        assertEquals("1 KB", fmtXferSize(500))
        assertEquals("1.0 MB", fmtXferSize(1_048_576))
    }

    @Test
    fun newOfferHidesTheExplainerAndKeepsTheTicketParsable() {
        val text = "📦 film.mp4 (6.7 MB) was sent with Velta Dash, which sends files of any size straight between Velta apps.\n" +
            "Open it in Velta, or learn more at https://velta.cc/dash\n$ticket"
        val card = parseFileCard(text)!!
        assertEquals("film.mp4", card.name)
        assertEquals(7_000_000, card.size)
        assertEquals(ticket, card.ticket)
        assertEquals("📎 film.mp4 · 6.7 MB", xferDisplayText(text))
        assertFalse(xferVisibleText(text).contains("velta.cc/dash"))
        assertFalse(xferVisibleText(text).contains("VXFER1:"))
        assertFalse(xferVisibleText(text).contains("was sent with Velta Dash"))
    }

    @Test
    fun oldWordingAndTruncatedSummariesAreHiddenToo() {
        val oldDash = "📎 shot.jpg · 576.7 KB — sent with Velta Dash\nIf your app can't open this, the file follows by email.\n$ticket"
        assertEquals("📎 film.mp4 · 6.7 MB", xferDisplayText(oldDash))
        val beam = "Offering Screenshot_1.jpg (576.7 KB) — open \"Velta Beam\" to receive\n$ticket"
        assertEquals("📎 film.mp4 · 6.7 MB", xferDisplayText(beam))
        assertEquals(
            "📎 film.mp4 · 52.9 MB",
            xferDisplayText("📦 film.mp4 (52.9 MB) was sent with Velta Dash, which sends files"),
        )
        assertEquals("📎 a.bin · 6.7 MB", xferDisplayText("📎 a.bin · 6.7 MB — sent with Velta Dash"))
        assertEquals(
            "📎 Screenshot_1.jpg · 576.7 KB",
            xferDisplayText("Offering Screenshot_1.jpg (576.7 KB) — open \"Velta Beam\" to receive"),
        )
        assertEquals("📎 x · 1.0 MB", xferDisplayText("Alice: 📦 x (1.0 MB) a été envoyé avec Velta Dash, qui envoie des fichiers"))
        assertEquals("Velta Dash", xferDisplayText("Open it in Velta, or learn more at https://velta.cc/dash"))
        assertEquals("Asked for the email copy", xferDisplayText("VXFER-RESEND:" + "ab".repeat(32)))
        assertNull(xferDisplayText("hello about Velta Dash later"))
        assertEquals("hello", xferVisibleText("hello"))
        assertFalse(looksLikeXferExplainer("just a chat"))
        assertTrue(looksLikeXferExplainer(oldDash))
    }
}
