package org.velta.kmp

import org.velta.kmp.ui.EPHEMERAL_OPTIONS
import org.velta.kmp.ui.L
import org.velta.kmp.ui.RELAY_FLAG_LABELS
import org.velta.kmp.ui.ephemeralTimerKey
import org.velta.kmp.ui.htmlBreaks
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

/** #334 step 9: labels mirror stable keys and actually translate. */
class I18nRulesTest {

    @AfterTest
    fun english() {
        L.lang = "en"
    }

    @Test
    fun ephemeralTimerMatchesStableOptions() {
        assertEquals("Off" to null, ephemeralTimerKey(0))
        assertEquals("After 1 week" to null, ephemeralTimerKey(7 * 86400))
        assertEquals("After 5 minutes" to null, ephemeralTimerKey(300))
        assertEquals("On ({n} s)" to 45, ephemeralTimerKey(45))
        assertEquals(7, EPHEMERAL_OPTIONS.size)
    }

    @Test
    fun stickerHintKeepsItsLineBreak() {
        assertEquals("a\nb", htmlBreaks("a<br>b"))
    }

    @Test
    fun tableLabelsTranslateInRuAndFr() {
        val keys = EPHEMERAL_OPTIONS.map { it.first } + RELAY_FLAG_LABELS.map { it.second } +
            listOf("Unread", "Updating…", "Battery optimization", "Account {id}", "Relay status")
        for (lang in listOf("ru", "fr")) {
            L.lang = lang
            for (k in keys) assertNotEquals(k, L.t(k), "$lang: \"$k\" stays English")
        }
    }
}
