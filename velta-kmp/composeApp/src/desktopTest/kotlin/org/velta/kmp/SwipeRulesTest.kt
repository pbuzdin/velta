package org.velta.kmp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.velta.kmp.ui.Peek
import org.velta.kmp.ui.SwipeAxis
import org.velta.kmp.ui.SwipeSpec
import org.velta.kmp.ui.arrowScale
import org.velta.kmp.ui.backCommitPx
import org.velta.kmp.ui.backExitTarget
import org.velta.kmp.ui.backFollow
import org.velta.kmp.ui.backSwipeAllowed
import org.velta.kmp.ui.inSystemGestureZone
import org.velta.kmp.ui.peekFor
import org.velta.kmp.ui.predictiveOffset
import org.velta.kmp.ui.releaseCommits
import org.velta.kmp.ui.replyFollow
import org.velta.kmp.ui.replySwipeAllowed
import org.velta.kmp.ui.swipeAxis
import org.velta.kmp.ui.swipeProgress
import org.velta.kmp.ui.thresholdTick

class SwipeRulesTest {
    private val eps = 0.001f

    @Test fun axisLockMatchesStable() {
        // Reply wants rightward.
        assertEquals(SwipeAxis.Horizontal, swipeAxis(12f, 3f, 12f, positive = true))
        assertEquals(SwipeAxis.Undecided, swipeAxis(11f, 0f, 12f, positive = true))
        assertEquals(SwipeAxis.Undecided, swipeAxis(-30f, 0f, 12f, positive = true))
        assertEquals(SwipeAxis.Vertical, swipeAxis(5f, 13f, 12f, positive = true))
        // A diagonal where vertical dominates cancels even if dx is past engage.
        assertEquals(SwipeAxis.Vertical, swipeAxis(14f, 20f, 12f, positive = true))
        // Back wants leftward.
        assertEquals(SwipeAxis.Horizontal, swipeAxis(-12f, 2f, 12f, positive = false))
        assertEquals(SwipeAxis.Undecided, swipeAxis(40f, 0f, 12f, positive = false))
    }

    @Test fun replyFollowIsLinearThenRubberBand() {
        assertEquals(0f, replyFollow(-10f, 48f, 28f))
        assertEquals(30f, replyFollow(30f, 48f, 28f))
        assertEquals(48f, replyFollow(48f, 48f, 28f))
        val a = replyFollow(60f, 48f, 28f)
        val b = replyFollow(120f, 48f, 28f)
        val c = replyFollow(10_000f, 48f, 28f)
        assertTrue(a > 48f && a < 60f, "resists past the line: $a")
        assertTrue(b > a, "still follows: $b")
        assertTrue(c < 48f + 28f, "never past the asymptote: $c")
        // Stable clamp without the fancy curve.
        assertEquals(76f, replyFollow(200f, 48f, 28f, fancy = false))
        assertEquals(50f, replyFollow(50f, 48f, 28f, fancy = false))
    }

    @Test fun progressAndArrowScale() {
        assertEquals(0f, swipeProgress(0f, 48f))
        assertEquals(0.5f, swipeProgress(24f, 48f), eps)
        assertEquals(1f, swipeProgress(100f, 48f))
        assertEquals(0.5f, swipeProgress(-36f, 72f), eps)
        assertEquals(SwipeSpec.ARROW_MIN_SCALE, arrowScale(0f))
        assertEquals(1f, arrowScale(1f))
        assertEquals(1f, arrowScale(3f))
    }

    @Test fun backCommitIsMin72dpOr28Percent() {
        // Phone 411dp @ 2.625: 72dp wins.
        assertEquals(72f * 2.625f, backCommitPx(411f * 2.625f, 2.625f), eps)
        // Narrow 200px @ 1x: 28% wins.
        assertEquals(56f, backCommitPx(200f, 1f), eps)
        assertEquals(0f, backFollow(30f, 400f))
        assertEquals(-400f, backFollow(-900f, 400f))
    }

    @Test fun cancelNeverCommits() {
        assertTrue(releaseCommits(48f, 48f, cancelled = false))
        assertTrue(releaseCommits(-80f, 72f, cancelled = false))
        assertFalse(releaseCommits(47f, 48f, cancelled = false))
        assertFalse(releaseCommits(60f, 48f, cancelled = true))
        assertFalse(releaseCommits(60f, 0f, cancelled = false))
    }

    @Test fun hapticOncePerCrossing() {
        var past = false
        val ticks = listOf(10f, 47f, 48f, 60f, 70f, 40f, 50f).map { dx ->
            val t = thresholdTick(past, dx, 48f); past = t.past; t.tick
        }
        assertEquals(listOf(false, false, true, false, false, false, true), ticks)
        // Leftward distances count by magnitude.
        assertTrue(thresholdTick(false, -72f, 72f).tick)
    }

    @Test fun systemGestureZones() {
        assertTrue(inSystemGestureZone(10f, 1080f, 48f, 48f))
        assertTrue(inSystemGestureZone(1070f, 1080f, 48f, 48f))
        assertFalse(inSystemGestureZone(500f, 1080f, 48f, 48f))
        // Three-button navigation: no zones.
        assertFalse(inSystemGestureZone(0f, 1080f, 0f, 0f))
        assertFalse(inSystemGestureZone(1080f, 1080f, 0f, 0f))
    }

    @Test fun replyAndBackNeverOverlap() {
        assertTrue(replySwipeAllowed(backActive = false, edgeDown = false, skipDown = false))
        assertFalse(replySwipeAllowed(backActive = true, edgeDown = false, skipDown = false))
        assertFalse(replySwipeAllowed(backActive = false, edgeDown = true, skipDown = false))
        assertFalse(replySwipeAllowed(backActive = false, edgeDown = false, skipDown = true))
        assertTrue(backSwipeAllowed(replyActive = false, edgeDown = false, skipDown = false))
        assertFalse(backSwipeAllowed(replyActive = true, edgeDown = false, skipDown = false))
        assertFalse(backSwipeAllowed(replyActive = false, edgeDown = true, skipDown = false))
    }

    @Test fun peekParallax() {
        assertEquals(Peek(0f, 1f, 0f), peekFor(-300f, 1000f, fancy = false))
        val start = peekFor(-1f, 1000f, fancy = true)
        assertTrue(start.translationX > 249f && start.translationX <= 250f)
        assertEquals(SwipeSpec.PEEK_SCALE, start.scale, 0.01f)
        assertEquals(SwipeSpec.PEEK_DIM, start.dim, 0.01f)
        val done = peekFor(-1000f, 1000f, fancy = true)
        assertEquals(0f, done.translationX, eps)
        assertEquals(1f, done.scale, eps)
        assertEquals(0f, done.dim, eps)
        // Chat moving right (predictive back from the left edge): list from the left.
        assertTrue(peekFor(200f, 1000f, fancy = true).translationX < 0f)
    }

    @Test fun predictiveBackFollowsEdge() {
        assertEquals(-0.5f * SwipeSpec.PREDICTIVE_TRAVEL * 1000f, predictiveOffset(0.5f, 1000f, false), eps)
        assertEquals(0.5f * SwipeSpec.PREDICTIVE_TRAVEL * 1000f, predictiveOffset(0.5f, 1000f, true), eps)
        assertEquals(-SwipeSpec.PREDICTIVE_TRAVEL * 1000f, predictiveOffset(2f, 1000f, null), eps)
        assertEquals(1000f, backExitTarget(10f, 1000f, null))
        assertEquals(-1000f, backExitTarget(-10f, 1000f, true))
        assertEquals(1000f, backExitTarget(0f, 1000f, true))
        assertEquals(-1000f, backExitTarget(0f, 1000f, null))
    }
}
