package org.velta.kmp.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

/** Decode an image file into an ImageBitmap, or null if it can't be read. */
expect fun decodeImage(path: String): ImageBitmap?

/**
 * Web .msg-image/.msg-video bleed (main.css: margin 2px -5px 5px): media
 * extends 5dp past the bubble's 10dp horizontal padding on both sides.
 * The child is measured with +10dp of width headroom and centered, which
 * pushes 5dp out of the padded column on each side.
 */
fun Modifier.mediaBleed(extra: Dp = 5.dp): Modifier = layout { measurable, constraints ->
    val bleed = extra.roundToPx()
    val wideConstraints = constraints.copy(
        minWidth = 0,
        maxWidth = if (constraints.hasBoundedWidth) constraints.maxWidth + bleed * 2 else constraints.maxWidth,
    )
    val placeable = measurable.measure(wideConstraints)
    // Report the child's width minus the headroom so the wrap-content bubble
    // grows by the real media size, then shift left to poke into the padding.
    val width = (placeable.width - bleed * 2).coerceAtLeast(0)
    layout(width, placeable.height) {
        placeable.place(-bleed, 0)
    }
}

/**
 * Renders a blob image (P4: media rendering). Decodes off the main thread;
 * falls back to a placeholder while loading or when undecodable.
 * Web parity (main.css .msg-image/.img-wrap): 320dp-wide box with a 450dp
 * height cap and the media radius; stickers cap at 175dp in a bare image.
 * The core-reported pixel size reserves the box before the decode lands
 * (aspect-ratio 4/3 fallback when unknown, like the web's .img-wrap).
 */
@Composable
fun MediaFromDisk(
    path: String,
    dimsW: Int? = null,
    dimsH: Int? = null,
    sticker: Boolean = false,
    modifier: Modifier = Modifier,
) {
    var bitmap by remember(path) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(path) {
        bitmap = withContext(Dispatchers.IO) { decodeImage(path) }
    }
    val tokens = Velta.tokens
    val maxW = if (sticker) 175.dp else 320.dp
    val maxH = if (sticker) 175.dp else 450.dp
    val decoded = bitmap
    if (decoded != null) {
        Image(
            bitmap = decoded,
            contentDescription = null,
            contentScale = ContentScale.FillWidth,
            modifier = modifier
                .widthIn(max = maxW)
                .heightIn(max = maxH)
                .clip(RoundedCornerShape(if (sticker) 0.dp else tokens.radiusMedia)),
        )
    } else {
        // Reserve box: the web pins 320px wide at 4/3; use the core-reported
        // aspect when it knows the real pixel size.
        val aspect = if (dimsW != null && dimsH != null && dimsW > 0 && dimsH > 0) {
            dimsW.toFloat() / dimsH.toFloat()
        } else 4f / 3f
        Box(
            modifier
                .widthIn(max = maxW)
                .heightIn(max = maxH)
                .aspectRatio(aspect, matchHeightConstraintsFirst = aspect < 1f)
                .clip(RoundedCornerShape(if (sticker) 0.dp else tokens.radiusMedia))
                .background(tokens.bgHover),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "📷 …",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
