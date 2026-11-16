package org.velta.kmp.ui

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Pre-send image editor rules (#334). Stable (chat-view.js
 * openImageCropper) has a free-form crop only; KMP extends it with aspect
 * presets, 90° rotation and a brush layer with undo/redo.
 *
 * Coordinates:
 * - crop rects are normalized 0..1 in the ROTATED image (what the user sees);
 * - stroke points are normalized 0..1 in the SOURCE image, so rotating
 *   after drawing keeps the drawing glued to the picture.
 */

/** Normalized rect, l < r and t < b, inside 0..1. */
data class NRect(val l: Float, val t: Float, val r: Float, val b: Float) {
    val w get() = r - l
    val h get() = b - t
    companion object { val Full = NRect(0f, 0f, 1f, 1f) }
}

/** Crop aspect presets. [ratio] = width / height; null = free, NaN = the picture's own. */
enum class AspectPreset(val label: String, val ratio: Float?) {
    Free("Free", null),
    Original("Original", Float.NaN),
    Square("1:1", 1f),
    FourThree("4:3", 4f / 3f),
    SixteenNine("16:9", 16f / 9f),
    ThreeFour("3:4", 3f / 4f),
}

/** Pixel size of the image after [quarterTurns] clockwise 90° turns. */
fun rotatedSize(w: Int, h: Int, quarterTurns: Int): Pair<Int, Int> =
    if (((quarterTurns % 4) + 4) % 4 % 2 == 1) h to w else w to h

/** Pixel ratio the preset asks for in the rotated image, or null for free. */
fun presetRatio(preset: AspectPreset, rotW: Int, rotH: Int): Float? = when {
    preset.ratio == null -> null
    preset.ratio.isNaN() -> if (rotH > 0) rotW.toFloat() / rotH else null
    else -> preset.ratio
}

/**
 * The largest rect with pixel aspect [ratio] that fits inside [inside],
 * centered on it (switching presets keeps the user's focus).
 */
fun fitAspect(inside: NRect, ratio: Float, rotW: Int, rotH: Int): NRect {
    if (rotW <= 0 || rotH <= 0 || ratio <= 0f) return inside
    val pw = inside.w * rotW
    val ph = inside.h * rotH
    val (w, h) = if (pw / ph > ratio) (ph * ratio) to ph else pw to (pw / ratio)
    val cx = (inside.l + inside.r) / 2f
    val cy = (inside.t + inside.b) / 2f
    val nw = w / rotW
    val nh = h / rotH
    return NRect(cx - nw / 2f, cy - nh / 2f, cx + nw / 2f, cy + nh / 2f)
}

/** Rotating the picture: the crop follows it (a clockwise turn maps (u,v) → (1-v, u)). */
fun rotateRectCw(r: NRect): NRect = NRect(1f - r.b, r.l, 1f - r.t, r.r)

enum class CropHandle { Move, TopLeft, TopRight, BottomLeft, BottomRight, Left, Top, Right, Bottom }

/**
 * Which handle a touch at ([x],[y]) px grabs on a crop frame drawn at
 * [frame] px (l, t, r, b); corners win over edges, inside = move, null =
 * outside (stable: a drag outside starts a new selection — here it is
 * ignored, the frame handles cover it on a phone).
 */
fun hitCropHandle(x: Float, y: Float, frame: NRect, touchPx: Float): CropHandle? {
    val nearL = abs(x - frame.l) <= touchPx
    val nearR = abs(x - frame.r) <= touchPx
    val nearT = abs(y - frame.t) <= touchPx
    val nearB = abs(y - frame.b) <= touchPx
    val inX = x >= frame.l - touchPx && x <= frame.r + touchPx
    val inY = y >= frame.t - touchPx && y <= frame.b + touchPx
    return when {
        nearL && nearT -> CropHandle.TopLeft
        nearR && nearT -> CropHandle.TopRight
        nearL && nearB -> CropHandle.BottomLeft
        nearR && nearB -> CropHandle.BottomRight
        nearL && inY -> CropHandle.Left
        nearR && inY -> CropHandle.Right
        nearT && inX -> CropHandle.Top
        nearB && inX -> CropHandle.Bottom
        x > frame.l && x < frame.r && y > frame.t && y < frame.b -> CropHandle.Move
        else -> null
    }
}

/**
 * Drag [handle] of [start] by ([dx],[dy]) normalized. Keeps the rect inside
 * 0..1 and at least [minN] on each side. With an aspect [ratio] (pixel
 * w/h in a [rotW]×[rotH] image) the opposite corner / edge stays anchored,
 * the ratio holds, and an edge drag grows the other axis around its center.
 */
fun dragCrop(
    start: NRect,
    handle: CropHandle,
    dx: Float,
    dy: Float,
    ratio: Float?,
    rotW: Int,
    rotH: Int,
    minN: Float = 0.08f,
): NRect {
    if (handle == CropHandle.Move) {
        val ndx = dx.coerceIn(-start.l, 1f - start.r)
        val ndy = dy.coerceIn(-start.t, 1f - start.b)
        return NRect(start.l + ndx, start.t + ndy, start.r + ndx, start.b + ndy)
    }
    var l = start.l; var t = start.t; var r = start.r; var b = start.b
    val left = handle == CropHandle.TopLeft || handle == CropHandle.BottomLeft || handle == CropHandle.Left
    val right = handle == CropHandle.TopRight || handle == CropHandle.BottomRight || handle == CropHandle.Right
    val top = handle == CropHandle.TopLeft || handle == CropHandle.TopRight || handle == CropHandle.Top
    val bottom = handle == CropHandle.BottomLeft || handle == CropHandle.BottomRight || handle == CropHandle.Bottom
    if (left) l = (start.l + dx).coerceIn(0f, start.r - minN)
    if (right) r = (start.r + dx).coerceIn(start.l + minN, 1f)
    if (top) t = (start.t + dy).coerceIn(0f, start.b - minN)
    if (bottom) b = (start.b + dy).coerceIn(start.t + minN, 1f)
    if (ratio == null || rotW <= 0 || rotH <= 0) return NRect(l, t, r, b)
    // Aspect lock: height follows width (n-space ratio converts pixels).
    val k = ratio * rotH / rotW // normalized w / h
    val horizontal = left || right
    val vertical = top || bottom
    var w = r - l
    var h = b - t
    if (horizontal && (!vertical || abs(dx) >= abs(dy))) h = w / k else w = h * k
    // Fit inside the image from the anchored side.
    val maxW = if (left) start.r else if (right) 1f - start.l else min(1f, w)
    val maxH = if (top) start.b else if (bottom) 1f - start.t else min(1f, h)
    val cxEdge = (start.l + start.r) / 2f
    val cyEdge = (start.t + start.b) / 2f
    val limW = if (horizontal) maxW else 2f * min(cxEdge, 1f - cxEdge)
    val limH = if (vertical) maxH else 2f * min(cyEdge, 1f - cyEdge)
    val scale = min(1f, min(limW / w, limH / h))
    w *= scale; h *= scale
    if (w < minN) { w = minN; h = w / k }
    if (h < minN) { h = minN; w = h * k }
    l = when { left -> start.r - w; right -> start.l; else -> cxEdge - w / 2f }
    r = l + w
    t = when { top -> start.b - h; bottom -> start.t; else -> cyEdge - h / 2f }
    b = t + h
    return NRect(l, t, r, b)
}

/** Map a point normalized in the rotated view back to the source image. */
fun rotatedToSource(u: Float, v: Float, quarterTurns: Int): Pair<Float, Float> =
    when (((quarterTurns % 4) + 4) % 4) {
        1 -> v to (1f - u)
        2 -> (1f - u) to (1f - v)
        3 -> (1f - v) to u
        else -> u to v
    }

/** The crop in source pixels after rotation, rounded, at least 1×1. */
fun cropPixels(crop: NRect, rotW: Int, rotH: Int): IntArray {
    val l = (crop.l * rotW).roundToInt().coerceIn(0, rotW - 1)
    val t = (crop.t * rotH).roundToInt().coerceIn(0, rotH - 1)
    val r = (crop.r * rotW).roundToInt().coerceIn(l + 1, rotW)
    val b = (crop.b * rotH).roundToInt().coerceIn(t + 1, rotH)
    return intArrayOf(l, t, r - l, b - t)
}

/** One brush stroke: ARGB colour, width as a share of the source's short side. */
data class BrushStroke(val argb: Long, val width: Float, val points: List<Pair<Float, Float>>)

/** Stable-ish palette: white, ink, red, orange, yellow, green, blue, violet. */
val BRUSH_COLORS: List<Long> = listOf(
    0xFFFFFFFF, 0xFF10131A, 0xFFFF5A5F, 0xFFFF9F43, 0xFFFFD43B, 0xFF4FD17A, 0xFF5AA2E6, 0xFFA37DFA,
)
const val BRUSH_MIN = 0.004f
const val BRUSH_MAX = 0.04f
const val BRUSH_DEFAULT = 0.012f

/** Everything the editor changes; immutable so undo/redo is a list of states. */
data class EditState(
    val quarterTurns: Int = 0,
    val crop: NRect = NRect.Full,
    val preset: AspectPreset = AspectPreset.Free,
    val strokes: List<BrushStroke> = emptyList(),
) {
    val edited get() = quarterTurns % 4 != 0 || crop != NRect.Full || strokes.isNotEmpty()
}

fun EditState.rotatedCw(srcW: Int, srcH: Int): EditState {
    val turns = (quarterTurns + 1) % 4
    val (rw, rh) = rotatedSize(srcW, srcH, turns)
    val moved = rotateRectCw(crop)
    val ratio = presetRatio(preset, rw, rh)
    return copy(quarterTurns = turns, crop = if (ratio == null) moved else fitAspect(moved, ratio, rw, rh))
}

fun EditState.withPreset(p: AspectPreset, srcW: Int, srcH: Int): EditState {
    val (rw, rh) = rotatedSize(srcW, srcH, quarterTurns)
    val ratio = presetRatio(p, rw, rh) ?: return copy(preset = p)
    return copy(preset = p, crop = fitAspect(NRect.Full, ratio, rw, rh))
}

/** Linear undo/redo over committed states (a new edit drops the redo tail). */
class EditHistory(initial: EditState = EditState()) {
    private val states = mutableListOf(initial)
    private var index = 0
    val current: EditState get() = states[index]
    val canUndo get() = index > 0
    val canRedo get() = index < states.size - 1
    fun push(s: EditState) {
        if (s == current) return
        while (states.size > index + 1) states.removeAt(states.size - 1)
        states.add(s)
        index = states.size - 1
    }
    fun undo(): EditState { if (canUndo) index--; return current }
    fun redo(): EditState { if (canRedo) index++; return current }
}

/** Which attachments the editor can open: decodable stills, not animations or vectors. */
fun canEditImage(name: String): Boolean =
    name.substringAfterLast('.', "").lowercase() in setOf("png", "jpg", "jpeg", "webp", "bmp", "heic", "heif")

/** Output name for an edited picture: same base, .jpg (photos) — keeps the user's naming. */
fun editedName(original: String): String {
    val base = original.substringBeforeLast('.', original).ifBlank { "image" }
    return if (base.endsWith("-edited")) "$base.jpg" else "$base-edited.jpg"
}

/** Decode cap for editing: big enough for a sharp send, small enough for RAM. */
const val EDIT_MAX_SIDE = 2560

/** Composer thumbnail: mm:ss (h:mm:ss past an hour), stable formatDuration style. */
fun formatClipDuration(ms: Long): String {
    val s = max(0L, ms / 1000)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "$h:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}"
    else "$m:${sec.toString().padStart(2, '0')}"
}
