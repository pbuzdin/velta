package org.velta.kmp

import org.velta.kmp.ui.qrCardGeom
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** i.delta.chat card: sizes must not pick up the letterbox offset. */
class QrCardTest {
    @Test
    fun cardSizesStayInCardUnits() {
        val g = qrCardGeom(630f, 20)
        assertEquals(59.5f, g.cardX, 0.01f)
        assertEquals(2f, g.cardY, 0.01f)
        assertEquals(511f, g.cardW, 0.01f)
        assertEquals(626f, g.cardH, 0.01f)
        assertEquals(40f, g.corner, 0.01f)
        assertEquals(2f, g.stroke, 0.01f)
        assertEquals(115f, g.qrX, 0.01f)
        assertEquals(75f, g.qrY, 0.01f)
        assertEquals(20f, g.cell, 0.01f)
        assertEquals(315f, g.discX, 0.01f)
        assertEquals(275f, g.discY, 0.01f)
        assertEquals(56.2f, g.ringR, 0.01f)
        assertEquals(47.2f, g.discR, 0.01f)
        assertTrue(g.cardX + g.cardW < 630f)
        assertTrue(g.ringR < 200f)
    }
}
