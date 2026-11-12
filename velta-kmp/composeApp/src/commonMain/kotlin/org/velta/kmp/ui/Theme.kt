package org.velta.kmp.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp

/**
 * The Velta look for the KMP client (#192, #318). Every value comes from the
 * generated [VeltaTokens] (tools/gen-kmp-theme.mjs reads Velta stable's
 * app/css/main.css), so the KMP client and the web client stay one family.
 * Never hard-code a Velta color here: change main.css and regenerate.
 */
enum class VeltaThemeMode { System, Dark, Light, Brutal, Amoled }

/** The settings-facing choice (web dw-theme values: auto/dark/light/brutal).
 * AMOLED is a separate flag, not a choice — see [veltaEffectiveMode]. */
enum class VeltaThemeChoice { Auto, Dark, Light, Brutal }

fun veltaTokensFor(mode: VeltaThemeMode, systemDark: Boolean): VeltaTokens = when (mode) {
    VeltaThemeMode.System -> if (systemDark) VeltaTokenSets.Dark else VeltaTokenSets.Light
    VeltaThemeMode.Dark -> VeltaTokenSets.Dark
    VeltaThemeMode.Light -> VeltaTokenSets.Light
    VeltaThemeMode.Brutal -> VeltaTokenSets.Brutal
    VeltaThemeMode.Amoled -> VeltaTokenSets.Amoled
}

/** Velta-only tokens (bubbles, meta ink, ticks, chat ground…) Material has no slot for. */
val LocalVeltaTokens = staticCompositionLocalOf { VeltaTokenSets.Dark }

/** Shortcut: `Velta.tokens.bgBubbleIn` inside a [VeltaTheme]. */
object Velta {
    val tokens: VeltaTokens
        @Composable get() = LocalVeltaTokens.current
}

internal fun veltaColorScheme(t: VeltaTokens): ColorScheme {
    val base = if (t.isDark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = t.accent,
        onPrimary = t.onAccent,
        primaryContainer = t.bgBubbleOut,
        onPrimaryContainer = t.textOut,
        secondary = t.accent2,
        onSecondary = t.onBadge,
        tertiary = t.green,
        background = t.bg,
        onBackground = t.text,
        surface = t.bgSidebar,
        onSurface = t.text,
        surfaceVariant = t.bgElev,
        onSurfaceVariant = t.textDim,
        surfaceContainerLowest = t.bg,
        surfaceContainerLow = t.bgSidebar,
        surfaceContainer = t.bgSidebar,
        surfaceContainerHigh = t.bgElev,
        surfaceContainerHighest = t.bgElev,
        inverseSurface = t.text,
        inverseOnSurface = t.bg,
        error = t.danger,
        onError = t.onAccent,
        outline = t.border,
        outlineVariant = t.border,
    )
}

internal fun veltaTypography(): Typography {
    val base = Typography()
    // Line height in sp, not em: Material's own styles use sp, and text fields
    // lerp bodyLarge -> bodySmall for the floating label, which throws on Em vs Sp.
    val msg = TextStyle(
        fontSize = VeltaType.msgSize,
        lineHeight = (VeltaType.msgSize.value * VeltaType.msgLineHeight).sp,
    )
    return base.copy(
        // Message body: main.css .msg-text (15.5px / 1.36).
        bodyLarge = base.bodyLarge.merge(msg),
        // Secondary body: chat list preview size (.ci-last).
        bodyMedium = base.bodyMedium.copy(fontSize = VeltaType.listLastSize),
        // Chat list title: .ci-name (15.5px semibold).
        titleMedium = base.titleMedium.copy(
            fontSize = VeltaType.listNameSize,
            fontWeight = FontWeight(VeltaType.listNameWeight),
        ),
        // Row time (.ci-time) and bubble meta (.msg-meta).
        labelMedium = base.labelMedium.copy(fontSize = VeltaType.listTimeSize),
        labelSmall = base.labelSmall.copy(fontSize = VeltaType.msgMetaSize),
    )
}

// extraLarge (dialogs, sheets) keeps Material's default: main.css has no token for it.
internal fun veltaShapes(t: VeltaTokens): Shapes = Shapes(
    extraSmall = RoundedCornerShape(t.radiusTail),
    small = RoundedCornerShape(t.radiusMedia),
    medium = RoundedCornerShape(t.radiusBubble),
    large = RoundedCornerShape(t.radiusBubble),
)

/** Bubble with its tail corner: bottom-start for incoming, bottom-end for outgoing (main.css .bubble). */
fun veltaBubbleShape(t: VeltaTokens, outgoing: Boolean): RoundedCornerShape {
    val r: Dp = t.radiusBubble
    return if (outgoing) {
        RoundedCornerShape(topStart = r, topEnd = r, bottomEnd = t.radiusTail, bottomStart = r)
    } else {
        RoundedCornerShape(topStart = r, topEnd = r, bottomEnd = r, bottomStart = t.radiusTail)
    }
}

/**
 * The web's theme model (app.js applyTheme): a choice of auto/dark/light/
 * brutal PLUS the "Pure black (AMOLED)" flag, which layers on dark only —
 * never its own theme value. Auto resolves to the system scheme.
 */
fun veltaEffectiveMode(choice: VeltaThemeChoice, amoled: Boolean, systemDark: Boolean): VeltaThemeMode {
    val base = when (choice) {
        VeltaThemeChoice.Auto -> if (systemDark) VeltaThemeMode.Dark else VeltaThemeMode.Light
        VeltaThemeChoice.Dark -> VeltaThemeMode.Dark
        VeltaThemeChoice.Light -> VeltaThemeMode.Light
        VeltaThemeChoice.Brutal -> VeltaThemeMode.Brutal
    }
    return if (amoled && base == VeltaThemeMode.Dark) VeltaThemeMode.Amoled else base
}

/**
 * System light/dark by default; theme choice + AMOLED flag + custom accent
 * via [mode]/[accentHex] (#321 step 5 settings). A valid [accentHex] swaps
 * in the Accent.derive() token set (WCAG-checked, web chat-appearance.js).
 */
@Composable
fun VeltaTheme(
    mode: VeltaThemeMode = VeltaThemeMode.System,
    accentHex: String? = null,
    content: @Composable () -> Unit,
) {
    var tokens = veltaTokensFor(mode, isSystemInDarkTheme())
    if (accentHex != null) {
        tokens = Accent.derive(tokens, accentHex, brutal = mode == VeltaThemeMode.Brutal)
    }
    CompositionLocalProvider(LocalVeltaTokens provides tokens) {
        MaterialTheme(
            colorScheme = veltaColorScheme(tokens),
            typography = veltaTypography(),
            shapes = veltaShapes(tokens),
            content = content,
        )
    }
}
