package org.velta.kmp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.velta.kmp.ui.AspectPreset
import org.velta.kmp.ui.BrushStroke
import org.velta.kmp.ui.CropHandle
import org.velta.kmp.ui.EditHistory
import org.velta.kmp.ui.EditState
import org.velta.kmp.ui.NRect
import org.velta.kmp.ui.canEditImage
import org.velta.kmp.ui.cropPixels
import org.velta.kmp.ui.dragCrop
import org.velta.kmp.ui.editedName
import org.velta.kmp.ui.fitAspect
import org.velta.kmp.ui.formatClipDuration
import org.velta.kmp.ui.hitCropHandle
import org.velta.kmp.ui.presetRatio
import org.velta.kmp.ui.rotateRectCw
import org.velta.kmp.ui.rotatedCw
import org.velta.kmp.ui.rotatedSize
import org.velta.kmp.ui.rotatedToSource
import org.velta.kmp.ui.withPreset

class ImageEditRulesTest {
    private val e = 0.0005f
    private fun near(a: NRect, b: NRect) {
        assertEquals(a.l, b.l, e); assertEquals(a.t, b.t, e); assertEquals(a.r, b.r, e); assertEquals(a.b, b.b, e)
    }

    @Test fun rotationSwapsSidesOnOddTurns() {
        assertEquals(400 to 300, rotatedSize(400, 300, 0))
        assertEquals(300 to 400, rotatedSize(400, 300, 1))
        assertEquals(400 to 300, rotatedSize(400, 300, 2))
        assertEquals(300 to 400, rotatedSize(400, 300, -1))
    }

    @Test fun presetsResolveAgainstTheRotatedPicture() {
        assertNull(presetRatio(AspectPreset.Free, 400, 300))
        assertEquals(4f / 3f, presetRatio(AspectPreset.Original, 400, 300)!!, e)
        assertEquals(0.75f, presetRatio(AspectPreset.Original, 300, 400)!!, e)
        assertEquals(1f, presetRatio(AspectPreset.Square, 300, 400)!!, e)
    }

    @Test fun fitAspectIsCenteredAndLargest() {
        // 400×300 picture, square crop → 300×300 centered: l = 50/400.
        near(NRect(0.125f, 0f, 0.875f, 1f), fitAspect(NRect.Full, 1f, 400, 300))
        // 16:9 in 400×300 → 400×225 centered vertically.
        val r = fitAspect(NRect.Full, 16f / 9f, 400, 300)
        assertEquals(0f, r.l, e); assertEquals(1f, r.r, e)
        assertEquals(225f / 300f, r.h, e)
        assertEquals(0.5f, (r.t + r.b) / 2f, e)
    }

    @Test fun rotatingTheCropFollowsThePicture() {
        // Top-left quarter becomes the top-right quarter after a clockwise turn.
        near(NRect(0.5f, 0f, 1f, 0.5f), rotateRectCw(NRect(0f, 0f, 0.5f, 0.5f)))
        var r = NRect(0.1f, 0.2f, 0.4f, 0.9f)
        repeat(4) { r = rotateRectCw(r) }
        near(NRect(0.1f, 0.2f, 0.4f, 0.9f), r)
    }

    @Test fun rotatedPointsMapBackToTheSource() {
        assertEquals(0.3f to 0.6f, rotatedToSource(0.3f, 0.6f, 0))
        // After one clockwise turn the source's top-left corner sits top-right.
        val (x, y) = rotatedToSource(1f, 0f, 1)
        assertEquals(0f, x, e); assertEquals(0f, y, e)
        val (x2, y2) = rotatedToSource(0f, 1f, 3)
        assertEquals(0f, x2, e); assertEquals(0f, y2, e)
        val (x3, y3) = rotatedToSource(0.25f, 0.75f, 2)
        assertEquals(0.75f, x3, e); assertEquals(0.25f, y3, e)
    }

    @Test fun handlesHitCornersFirstThenEdgesThenInside() {
        val f = NRect(100f, 100f, 300f, 250f)
        assertEquals(CropHandle.TopLeft, hitCropHandle(105f, 95f, f, 24f))
        assertEquals(CropHandle.BottomRight, hitCropHandle(310f, 260f, f, 24f))
        assertEquals(CropHandle.Left, hitCropHandle(90f, 180f, f, 24f))
        assertEquals(CropHandle.Bottom, hitCropHandle(200f, 240f, f, 24f))
        assertEquals(CropHandle.Move, hitCropHandle(200f, 175f, f, 24f))
        assertNull(hitCropHandle(20f, 20f, f, 24f))
    }

    @Test fun freeDragStaysInsideAndKeepsAMinimum() {
        val s = NRect(0.2f, 0.2f, 0.8f, 0.8f)
        near(NRect(0f, 0f, 0.6f, 0.6f), dragCrop(s, CropHandle.Move, -0.5f, -0.5f, null, 400, 300))
        near(NRect(0.1f, 0.2f, 0.8f, 0.8f), dragCrop(s, CropHandle.Left, -0.1f, 0.3f, null, 400, 300))
        val tiny = dragCrop(s, CropHandle.BottomRight, -0.9f, -0.9f, null, 400, 300)
        assertEquals(0.08f, tiny.w, e); assertEquals(0.08f, tiny.h, e)
        val out = dragCrop(s, CropHandle.TopRight, 0.9f, -0.9f, null, 400, 300)
        assertEquals(1f, out.r, e); assertEquals(0f, out.t, e)
    }

    @Test fun lockedDragKeepsTheRatioAndAnchor() {
        val start = fitAspect(NRect.Full, 1f, 400, 300) // square
        val r = dragCrop(start, CropHandle.BottomRight, -0.2f, 0f, 1f, 400, 300)
        assertEquals(r.w * 400, r.h * 300, 0.5f) // still square in pixels
        assertEquals(start.l, r.l, e); assertEquals(start.t, r.t, e) // anchored top-left
        // Growing past the picture is clamped, ratio kept.
        val big = dragCrop(NRect(0.3f, 0.3f, 0.5f, 0.5f), CropHandle.TopLeft, -1f, -1f, 4f / 3f, 400, 300)
        assertTrue(big.l >= -e && big.t >= -e)
        assertEquals(4f / 3f, (big.w * 400) / (big.h * 300), 0.01f)
    }

    @Test fun cropPixelsRoundAndClamp() {
        assertEquals(listOf(50, 0, 300, 300), cropPixels(NRect(0.125f, 0f, 0.875f, 1f), 400, 300).toList())
        assertEquals(listOf(399, 299, 1, 1), cropPixels(NRect(1f, 1f, 1f, 1f), 400, 300).toList())
    }

    @Test fun stateHelpersAndUndoRedo() {
        val s0 = EditState()
        assertFalse(s0.edited)
        val sq = s0.withPreset(AspectPreset.Square, 400, 300)
        assertTrue(sq.edited)
        val turned = sq.rotatedCw(400, 300)
        assertEquals(1, turned.quarterTurns)
        // Square stays square in the 300×400 turned picture.
        assertEquals(turned.crop.w * 300, turned.crop.h * 400, 0.5f)

        val h = EditHistory()
        h.push(sq)
        h.push(turned)
        assertTrue(h.canUndo); assertFalse(h.canRedo)
        assertEquals(sq, h.undo())
        assertEquals(turned, h.redo())
        h.undo()
        val drawn = sq.copy(strokes = listOf(BrushStroke(0xFFFF5A5F, 0.01f, listOf(0.1f to 0.1f))))
        h.push(drawn)
        assertFalse(h.canRedo) // a new edit drops the redo tail
        assertEquals(drawn, h.current)
        h.push(drawn) // no-op duplicate
        assertEquals(sq, h.undo())
    }

    @Test fun namesAndKinds() {
        assertTrue(canEditImage("IMG_1.JPG"))
        assertTrue(canEditImage("shot.png"))
        assertFalse(canEditImage("anim.gif"))
        assertFalse(canEditImage("logo.svg"))
        assertEquals("IMG_1-edited.jpg", editedName("IMG_1.JPG"))
        assertEquals("IMG_1-edited.jpg", editedName("IMG_1-edited.jpg"))
        assertEquals("image-edited.jpg", editedName(".png"))
        assertEquals("0:42", formatClipDuration(42_400))
        assertEquals("12:05", formatClipDuration(725_000))
        assertEquals("1:02:03", formatClipDuration(3_723_000))
    }
}
