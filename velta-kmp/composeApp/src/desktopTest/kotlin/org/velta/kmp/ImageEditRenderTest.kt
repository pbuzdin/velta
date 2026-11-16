package org.velta.kmp

import androidx.compose.ui.graphics.Canvas
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.geometry.Rect
import kotlin.test.Test
import kotlin.test.assertEquals
import org.velta.kmp.ui.BrushStroke
import org.velta.kmp.ui.EditState
import org.velta.kmp.ui.NRect
import org.velta.kmp.ui.renderEdit

class ImageEditRenderTest {
    /** 40×20: left half red, right half blue. */
    private fun source(): ImageBitmap {
        val img = ImageBitmap(40, 20)
        val c = Canvas(img)
        c.drawRect(Rect(0f, 0f, 20f, 20f), Paint().apply { color = Color.Red })
        c.drawRect(Rect(20f, 0f, 40f, 20f), Paint().apply { color = Color.Blue })
        return img
    }

    @Test fun untouchedRenderKeepsPixels() {
        val out = renderEdit(source(), EditState()).toPixelMap()
        assertEquals(40, out.width); assertEquals(20, out.height)
        assertEquals(Color.Red, out[5, 10]); assertEquals(Color.Blue, out[35, 10])
    }

    @Test fun clockwiseTurnPutsTheLeftHalfOnTop() {
        val out = renderEdit(source(), EditState(quarterTurns = 1)).toPixelMap()
        assertEquals(20, out.width); assertEquals(40, out.height)
        assertEquals(Color.Red, out[10, 5]); assertEquals(Color.Blue, out[10, 35])
    }

    @Test fun cropKeepsOnlyTheSelection() {
        val out = renderEdit(source(), EditState(crop = NRect(0.5f, 0f, 1f, 1f))).toPixelMap()
        assertEquals(20, out.width); assertEquals(20, out.height)
        assertEquals(Color.Blue, out[2, 10])
    }

    @Test fun strokesAreBakedIn() {
        val white = BrushStroke(0xFFFFFFFF, 0.5f, listOf(0.25f to 0.5f))
        val out = renderEdit(source(), EditState(strokes = listOf(white))).toPixelMap()
        assertEquals(Color.White, out[10, 10])
        assertEquals(Color.Blue, out[35, 10])
    }
}
