package org.velta.kmp

import androidx.compose.runtime.MonotonicFrameClock
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.velta.kmp.ui.SwipeOffset
import org.velta.kmp.ui.stackShowsList

/** #334 swipe-back blink: the commit must navigate with the pane already
 *  off-screen, never after a reset to 0, and the list must stay composed. */
class SwipeCommitOrderTest {
    private class Clock : MonotonicFrameClock {
        var t = 0L
        override suspend fun <R> withFrameNanos(onFrame: (frameTimeNanos: Long) -> R): R {
            yield()
            t += 16_000_000L
            return onFrame(t)
        }
    }

    @Test fun slideOutNavigatesOnlyAtFullWidth() = runBlocking(Clock()) {
        val o = SwipeOffset()
        o.value = -120f
        val seen = mutableListOf<Float>()
        var navigatedAt: Float? = null
        o.slideOut(this, -1080f, fancy = true) { navigatedAt = o.value }
        // Watch every frame until navigation.
        while (navigatedAt == null) { seen += o.value; yield() }
        assertEquals(-1080f, navigatedAt)
        assertTrue(seen.none { it > -120f + 0.01f }, "never slides back toward rest: $seen")
        repeat(5) { yield() }
        assertEquals(-1080f, o.value, "offset stays off-screen after the switch")
    }

    @Test fun reducedMotionSwitchesWithoutResettingTheOffset() = runBlocking(Clock()) {
        val o = SwipeOffset()
        o.value = -300f
        var navigatedAt: Float? = null
        o.slideOut(this, -1080f, fancy = false) { navigatedAt = o.value }
        assertEquals(-300f, navigatedAt, "no flash back to 0 before the switch")
    }

    @Test fun listStaysComposedAcrossTheCommit() {
        // Chat open at rest: no list underneath.
        assertFalse(stackShowsList(chatOpen = true, offsetPx = 0f))
        // Dragging / predictive back / committed slide: the list peeks.
        assertTrue(stackShowsList(chatOpen = true, offsetPx = -400f))
        assertTrue(stackShowsList(chatOpen = true, offsetPx = -1080f))
        // After the switch (fresh offset 0, no chat): still the same list.
        assertTrue(stackShowsList(chatOpen = false, offsetPx = 0f))
    }
}
