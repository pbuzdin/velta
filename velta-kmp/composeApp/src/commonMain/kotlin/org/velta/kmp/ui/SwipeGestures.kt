package org.velta.kmp.ui

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.vector.VectorPainter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** Snap-back: a soft spring with a hint of overshoot (stable .16s ease-out). */
internal val swipeSnapSpring = spring<Float>(dampingRatio = 0.72f, stiffness = Spring.StiffnessMediumLow)

/**
 * One animated horizontal offset driven by a finger (direct writes) or a
 * settle animation. A new touch [stop]s the settle and grabs the offset
 * where it is — interruptible both ways. Reduced motion snaps instead.
 */
@Stable
internal class SwipeOffset {
    var value by mutableFloatStateOf(0f)
    private var job: Job? = null

    fun stop() { job?.cancel(); job = null }

    fun snapTo(v: Float) { stop(); value = v }

    /** Spring home (or to [target]); [then] runs after the motion lands. */
    fun settle(scope: CoroutineScope, target: Float, fancy: Boolean, then: () -> Unit = {}) {
        stop()
        if (!fancy) { value = target; then(); return }
        job = scope.launch {
            animate(value, target, animationSpec = swipeSnapSpring) { v, _ -> value = v }
            then()
        }
    }

    /** Committed slide off-screen (stable .18s ease-out), then [then]. */
    fun slideOut(scope: CoroutineScope, target: Float, fancy: Boolean, then: () -> Unit) {
        stop()
        if (!fancy) { value = 0f; then(); return }
        job = scope.launch {
            animate(value, target, animationSpec = tween(SwipeSpec.COMMIT_SLIDE_MS, easing = FastOutSlowInEasing)) { v, _ ->
                value = v
            }
            then()
        }
    }
}

/**
 * Reply arrow revealed in the gap a swiped bubble leaves behind: a 32dp
 * disc centered in the gap that fades in with progress, grows from 0.5 to
 * 1 and is scaled by [pop] (the threshold "pop"). Drawn before the
 * bubble's translation so it stays put while the bubble moves.
 */
internal fun Modifier.replyArrowBehind(
    dx: () -> Float,
    commitPx: Float,
    pop: () -> Float,
    painter: VectorPainter,
    disc: () -> Color,
    tint: () -> Color,
    discPx: Float,
    iconPx: Float,
): Modifier = drawBehind {
    val d = dx()
    if (d <= 0.5f) return@drawBehind
    val progress = swipeProgress(d, commitPx)
    val s = arrowScale(progress) * pop()
    val cx = d / 2f
    val cy = size.height / 2f
    scale(s, pivot = Offset(cx, cy)) {
        val c = disc()
        drawCircle(c.copy(alpha = c.alpha * progress), radius = discPx / 2f, center = Offset(cx, cy))
        translate(cx - iconPx / 2f, cy - iconPx / 2f) {
            with(painter) {
                draw(Size(iconPx, iconPx), alpha = progress, colorFilter = ColorFilter.tint(tint()))
            }
        }
    }
}
