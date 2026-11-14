package org.velta.kmp

import org.velta.kmp.ui.formatListTime
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Chat-list stamps: core ChatListItem.lastUpdated is MILLIS — the web maps
 * `lastTs: c.lastUpdated` with exactly that comment (rpc-core.js:855). The
 * KMP fed the raw value to Instant.ofEpochSecond, so every row rendered a
 * date in the year ~58838 ("Feb 3, +58838"); af46d1d4 divides at the call
 * site, so the formatter's contract is SECONDS. These pins hold the
 * formatter side of that layering: if the wire unit or the division ever
 * drifts again, the stamps regress to a ~588xx year.
 */
class FormatTimeTest {

    @Test
    fun listStampTakesSecondsTodayIsClockTime() {
        val nowSecs = System.currentTimeMillis() / 1000
        // Today's stamp is HH:mm — no year fragment. (Reading the raw ms
        // value as seconds lands in the year ~58838 and prints one.)
        val today = formatListTime(nowSecs)
        assertTrue(Regex("""^\d{2}:\d{2}$""").matches(today), "today stamp = HH:mm, got '$today'")
    }

    @Test
    fun listStampShowsTheRealYearForOldRows() {
        // 1_600_000_000 s = 2020-09-13: beyond the 6-day weekday window and
        // in a different year, so the "MMM d, yyyy" branch renders.
        val old = formatListTime(1_600_000_000L)
        assertTrue(old.contains("2020"), "old stamp shows its year, got '$old'")
        assertFalse(old.contains("58838"))
    }
}
