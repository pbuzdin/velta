package org.velta.kmp

import org.velta.kmp.ui.glassRim
import org.velta.kmp.ui.glassSignedDistance
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class GlassTest {
    @Test
    fun glassRimIsFlatInTheMiddleAndHighAtTheEdge() {
        val center = glassSignedDistance(0f, 0f, 100f, 30f, 22f)
        assertTrue(center < -20f)
        assertEquals(0f, glassRim(center, 18f), 0.001f)
        val edge = glassSignedDistance(-99f, 0f, 100f, 30f, 22f)
        assertTrue(edge > -3f && edge < 0f)
        assertTrue(glassRim(edge, 18f) > 0.8f)
    }
}
