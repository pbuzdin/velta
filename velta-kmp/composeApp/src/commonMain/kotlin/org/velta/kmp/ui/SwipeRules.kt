package org.velta.kmp.ui

import kotlin.math.abs
import kotlin.math.min

/**
 * Swipe-to-reply and swipe-back rules (#334). Thresholds mirror Velta
 * stable (app/js/chat-view.js reply swipe ~3035-3110, _bindHistorySwipe
 * ~5463-5590); the motion values on top are KMP-only polish and drop out
 * when the system animator scale is 0 ([fancy] = false).
 *
 * All distances are in px; callers pass `dp * density`.
 */
object SwipeSpec {
    /** Both swipes engage once the finger travels 12dp along their axis. */
    const val ENGAGE_DP = 12f
    /** Reply commits at 48dp (stable tick line). */
    const val REPLY_COMMIT_DP = 48f
    /** Past the commit line the bubble keeps following with resistance and
     *  never travels more than this much further (stable clamps at 64dp). */
    const val REPLY_RUBBER_DP = 28f
    /** Back commits at min(72dp, 28% of the pane width). */
    const val BACK_COMMIT_DP = 72f
    const val BACK_COMMIT_FRACTION = 0.28f

    /** Reply arrow: starts at this scale, reaches 1 at the commit line. */
    const val ARROW_MIN_SCALE = 0.5f
    /** Reply arrow "pop" peak when the commit line is crossed. */
    const val ARROW_POP_SCALE = 1.2f

    /** Chat list underneath starts shifted 25% of the width and settles as
     *  the chat slides away (parallax). */
    const val PEEK_PARALLAX = 0.25f
    const val PEEK_SCALE = 0.94f
    const val PEEK_DIM = 0.32f
    /** Predictive back (Android 14+) moves the chat at most this share of
     *  the width before the gesture commits. */
    const val PREDICTIVE_TRAVEL = 0.4f

    /** Settle durations used when motion is reduced to plain slides
     *  (stable .16s / .18s ease-out) — reduced motion snaps instantly. */
    const val COMMIT_SLIDE_MS = 180
}

enum class SwipeAxis { Undecided, Horizontal, Vertical }

/**
 * Stable axis lock: a vertical move over the engage distance that dominates
 * cancels the swipe; a move of at least the engage distance in the wanted
 * direction ([positive] = rightward) that dominates engages it.
 */
fun swipeAxis(dx: Float, dy: Float, engagePx: Float, positive: Boolean): SwipeAxis {
    if (abs(dy) > engagePx && abs(dy) >= abs(dx)) return SwipeAxis.Vertical
    val along = if (positive) dx else -dx
    if (along >= engagePx && abs(dx) >= abs(dy)) return SwipeAxis.Horizontal
    return SwipeAxis.Undecided
}

/**
 * Reply follow: 1:1 up to the commit line, then rubber-band resistance that
 * approaches commit + [extraPx] but never reaches it. Never negative.
 */
fun replyFollow(rawDx: Float, commitPx: Float, extraPx: Float, fancy: Boolean = true): Float {
    if (rawDx <= 0f) return 0f
    if (rawDx <= commitPx) return rawDx
    if (!fancy || extraPx <= 0f) return min(rawDx, commitPx + extraPx)
    val over = rawDx - commitPx
    return commitPx + extraPx * (1f - 1f / (over / extraPx + 1f))
}

/** 0..1 share of the way to the commit line (reply arrow alpha). */
fun swipeProgress(dx: Float, commitPx: Float): Float =
    if (commitPx <= 0f) 0f else (abs(dx) / commitPx).coerceIn(0f, 1f)

/** Reply arrow scale before the pop: grows from [SwipeSpec.ARROW_MIN_SCALE] to 1. */
fun arrowScale(progress: Float): Float =
    SwipeSpec.ARROW_MIN_SCALE + (1f - SwipeSpec.ARROW_MIN_SCALE) * progress.coerceIn(0f, 1f)

/** Back commit distance: min(72dp, 28% of the width). */
fun backCommitPx(widthPx: Float, density: Float): Float =
    min(SwipeSpec.BACK_COMMIT_DP * density, widthPx * SwipeSpec.BACK_COMMIT_FRACTION)

/** Back follow: leftward only, never past the full width. */
fun backFollow(rawDx: Float, widthPx: Float): Float = rawDx.coerceIn(-widthPx, 0f)

/**
 * A release commits only past the line and only for a real lift: a cancel
 * (the system took the touch — edge back, notification shade) never does.
 */
fun releaseCommits(dx: Float, commitPx: Float, cancelled: Boolean): Boolean =
    !cancelled && commitPx > 0f && abs(dx) >= commitPx

/**
 * Haptic once per crossing of the commit line (stable: re-armed when the
 * finger goes back below). Returns the new armed state and whether to tick.
 */
data class ThresholdTick(val past: Boolean, val tick: Boolean)

fun thresholdTick(wasPast: Boolean, dx: Float, commitPx: Float): ThresholdTick {
    val past = abs(dx) >= commitPx
    return ThresholdTick(past, past && !wasPast)
}

/**
 * A touch that starts inside the system gesture zones (Android gesture
 * navigation edges, WindowInsets.systemGestures) belongs to the system back
 * gesture, not to an in-app swipe. [x] is window-relative.
 */
fun inSystemGestureZone(x: Float, windowWidthPx: Float, leftInsetPx: Float, rightInsetPx: Float): Boolean =
    (leftInsetPx > 0f && x < leftInsetPx) || (rightInsetPx > 0f && x > windowWidthPx - rightInsetPx)

/** Who may start a horizontal swipe right now — the two never overlap. */
fun replySwipeAllowed(backActive: Boolean, edgeDown: Boolean, skipDown: Boolean): Boolean =
    !backActive && !edgeDown && !skipDown

fun backSwipeAllowed(replyActive: Boolean, edgeDown: Boolean, skipDown: Boolean): Boolean =
    !replyActive && !edgeDown && !skipDown

/** Chat list underneath the sliding chat. */
data class Peek(val translationX: Float, val scale: Float, val dim: Float)

/**
 * The list peeks from the side the chat leaves: it starts offset by
 * [SwipeSpec.PEEK_PARALLAX] of the width, scaled down and dimmed, and
 * reaches its resting place as the chat slides fully away. Reduced motion
 * shows it flat (stable .swipe-back just reveals the sidebar).
 */
fun peekFor(offsetPx: Float, widthPx: Float, fancy: Boolean): Peek {
    if (!fancy || widthPx <= 0f) return Peek(0f, 1f, 0f)
    val p = (abs(offsetPx) / widthPx).coerceIn(0f, 1f)
    // Chat moving left → list sits a little to the right, and vice versa.
    val side = if (offsetPx < 0f) 1f else -1f
    return Peek(
        translationX = side * (1f - p) * SwipeSpec.PEEK_PARALLAX * widthPx,
        scale = SwipeSpec.PEEK_SCALE + (1f - SwipeSpec.PEEK_SCALE) * p,
        dim = SwipeSpec.PEEK_DIM * (1f - p),
    )
}

/**
 * Predictive back: the chat follows the system progress toward the edge
 * opposite the one the swipe started from (left edge → moves right). A
 * three-button / key back has no edge and leaves leftward like stable.
 */
fun predictiveOffset(progress: Float, widthPx: Float, fromLeftEdge: Boolean?): Float {
    val sign = if (fromLeftEdge == true) 1f else -1f
    return sign * progress.coerceIn(0f, 1f) * SwipeSpec.PREDICTIVE_TRAVEL * widthPx
}

/** Where a committed back slides the chat to. */
fun backExitTarget(currentOffset: Float, widthPx: Float, fromLeftEdge: Boolean?): Float = when {
    currentOffset > 0f -> widthPx
    currentOffset < 0f -> -widthPx
    fromLeftEdge == true -> widthPx
    else -> -widthPx
}
