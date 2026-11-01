package org.velta.kmp.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * Velta brand palette, lifted from the PWA's tokens (app/css/main.css) so the
 * KMP client and the web client read as one family. Dark values from the
 * PWA's dark theme, light from its light theme.
 */
private object VeltaColors {
    // Shared
    val accentLight = Color(0xFF3390EC) // light theme accent
    val accentDark = Color(0xFF5AA2E6) // dark theme accent

    // Dark
    val darkBg = Color(0xFF0F0F14)
    val darkElev = Color(0xFF1C1C26)
    val darkSidebar = Color(0xFF181820)
    val darkBubbleOut = Color(0xFF2B5278)
    val darkBorder = Color(0xFF45434F)
    val darkFg = Color(0xFFE8EAF0)

    // Light
    val lightBg = Color(0xFFF4F4F4)
    val lightElev = Color(0xFFE7EBF0)
    val lightBubbleOut = Color(0xFFE1F0FB)
    val lightFg = Color(0xFF1B1B22)
}

private val DarkScheme = darkColorScheme(
    primary = VeltaColors.accentDark,
    onPrimary = Color(0xFF0B1B2A),
    primaryContainer = VeltaColors.darkBubbleOut,
    onPrimaryContainer = Color(0xFFDCEBFF),
    secondary = VeltaColors.accentDark,
    background = VeltaColors.darkBg,
    onBackground = VeltaColors.darkFg,
    surface = VeltaColors.darkBg,
    onSurface = VeltaColors.darkFg,
    surfaceVariant = VeltaColors.darkElev,
    onSurfaceVariant = Color(0xFFA9ADBB),
    outline = VeltaColors.darkBorder,
)

private val LightScheme = lightColorScheme(
    primary = VeltaColors.accentLight,
    onPrimary = Color.White,
    primaryContainer = VeltaColors.lightBubbleOut,
    onPrimaryContainer = Color(0xFF12293D),
    secondary = VeltaColors.accentLight,
    background = VeltaColors.lightBg,
    onBackground = VeltaColors.lightFg,
    surface = VeltaColors.lightBg,
    onSurface = VeltaColors.lightFg,
    surfaceVariant = VeltaColors.lightElev,
    onSurfaceVariant = Color(0xFF5A5E6A),
    outline = Color(0xFFC4C8D0),
)

/** P4 slice 1 (issue #192): the Velta look, shared by both platforms. */
@Composable
fun VeltaTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    MaterialTheme(
        colorScheme = if (dark) DarkScheme else LightScheme,
        content = content,
    )
}
