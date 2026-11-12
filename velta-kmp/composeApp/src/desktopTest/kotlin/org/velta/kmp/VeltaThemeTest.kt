/*
 * #318: the Compose theme maps the generated main.css tokens. Pins a few
 * values and the mode/Material mapping; tests/kmp-theme-tokens.test.mjs
 * pins that VeltaTokens.kt itself is in sync with main.css.
 */
package org.velta.kmp

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame
import org.velta.kmp.ui.VeltaThemeMode
import org.velta.kmp.ui.VeltaTokenSets
import org.velta.kmp.ui.veltaColorScheme
import org.velta.kmp.ui.veltaTokensFor
import org.velta.kmp.ui.veltaTypography
import androidx.compose.ui.text.lerp

class VeltaThemeTest {
    @Test
    fun tokensMatchMainCss() {
        assertEquals(Color(0xFFE7EBF0), VeltaTokenSets.Light.bgChat)
        assertEquals(Color(0xFFF4F4F4), VeltaTokenSets.Light.bgBubbleIn)
        assertEquals(Color(0xFF0B0B10), VeltaTokenSets.Dark.bgChat)
        assertEquals(Color(0xFFF2F2F5), VeltaTokenSets.Dark.text)
        assertEquals(Color(0xF4, 0xF4, 0xF4, 0x12), VeltaTokenSets.Dark.border)
        assertEquals(6.dp, VeltaTokenSets.Brutal.radiusBubble)
        assertEquals(Color.Black, VeltaTokenSets.Amoled.bg)
    }

    @Test
    fun systemModeFollowsTheOs() {
        assertSame(VeltaTokenSets.Dark, veltaTokensFor(VeltaThemeMode.System, systemDark = true))
        assertSame(VeltaTokenSets.Light, veltaTokensFor(VeltaThemeMode.System, systemDark = false))
        assertSame(VeltaTokenSets.Brutal, veltaTokensFor(VeltaThemeMode.Brutal, systemDark = false))
    }

    @Test
    fun materialSchemeUsesTheTokens() {
        val s = veltaColorScheme(VeltaTokenSets.Light)
        assertEquals(VeltaTokenSets.Light.accent, s.primary)
        assertEquals(VeltaTokenSets.Light.bgBubbleOut, s.primaryContainer)
        assertEquals(VeltaTokenSets.Light.text, s.onBackground)
        assertEquals(VeltaTokenSets.Light.border, s.outline)
    }

    @Test
    fun typographyStylesLerpWithoutUnitMismatch() {
        // Text field labels lerp bodyLarge <-> bodySmall; Em vs Sp crashed on launch.
        val t = veltaTypography()
        lerp(t.bodyLarge, t.bodySmall, 0.5f)
        lerp(t.bodyMedium, t.bodySmall, 0.5f)
    }
}
