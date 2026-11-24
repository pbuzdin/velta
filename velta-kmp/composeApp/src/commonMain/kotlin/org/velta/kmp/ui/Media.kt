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
 * Decoded-bitmap memory cache (#507): avatars, quote thumbs, stickers and
 * bubble media were decoded at full size on every composition. LRU by
 * estimated bytes, keyed by path + size bucket; blob paths are content-
 * addressed, so entries never go stale. Failed decodes are not cached —
 * a file that appears later (media gate download) must decode fresh.
 */
private object ImageMemory {
    private const val MAX_BYTES = 48 * 1024 * 1024
    private val map = object : LinkedHashMap<String, ImageBitmap>(64, 0.75f, true) {}
    private var bytes = 0

    private fun cost(b: ImageBitmap) = b.width * b.height * 4

    @Synchronized
    fun get(key: String): ImageBitmap? = map[key]

    @Synchronized
    fun put(key: String, bmp: ImageBitmap) {
        map.put(key, bmp)?.let { bytes -= cost(it) }
        bytes += cost(bmp)
        val it = map.entries.iterator()
        while (bytes > MAX_BYTES && map.size > 1 && it.hasNext()) {
            bytes -= cost(it.next().value)
            it.remove()
        }
    }
}

/** Round up to a shared bucket so nearby display sizes hit the same entry. */
private fun imageBucket(px: Int): Int =
    listOf(256, 512, 768, 1024, 1536, 2048).firstOrNull { px <= it } ?: 4096

/** Cached, sampled (decodeImageScaled), off the caller's thread. */
suspend fun cachedImage(path: String, maxSidePx: Int): ImageBitmap? {
    val key = "${imageBucket(maxSidePx)}:$path"
    ImageMemory.get(key)?.let { return it }
    val bmp = withContext(Dispatchers.IO) { decodeImageScaled(path, imageBucket(maxSidePx)) } ?: return null
    ImageMemory.put(key, bmp)
    return bmp
}

/** Composition-side [cachedImage]: the cached value at once, else null until the decode lands. */
@Composable
fun rememberCachedImage(path: String?, maxSidePx: Int): ImageBitmap? {
    if (path == null) return null
    val bucket = imageBucket(maxSidePx)
    var bmp by remember(path, bucket) { mutableStateOf(ImageMemory.get("$bucket:$path")) }
    LaunchedEffect(path, bucket) {
        if (bmp == null) bmp = cachedImage(path, bucket)
    }
    return bmp
}

/**
 * Web .msg-image/.msg-video (main.css margin 2px -5px 5px).
 * Horizontal: 5dp past the bubble's 10dp padding. The child is measured
 * with +10dp of width and shifted left.
 * Vertical: 5dp under the media, so a caption is not flush with the picture.
 * The 2px top is not added here. A sender name already has 2dp under it,
 * and a quote already has 5dp (the web zeros this top margin after a quote).
 */
fun Modifier.mediaBleed(extra: Dp = 5.dp): Modifier = layout { measurable, constraints ->
    val bleed = extra.roundToPx()
    val under = 5.dp.roundToPx()
    val wideConstraints = constraints.copy(
        minWidth = 0,
        maxWidth = if (constraints.hasBoundedWidth) constraints.maxWidth + bleed * 2 else constraints.maxWidth,
    )
    val placeable = measurable.measure(wideConstraints)
    // Report the child's width minus the headroom so the wrap-content bubble
    // grows by the real media size, then shift left to poke into the padding.
    val width = (placeable.width - bleed * 2).coerceAtLeast(0)
    layout(width, placeable.height + under) {
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
    val maxW = if (sticker) 175.dp else 320.dp
    val maxH = if (sticker) 175.dp else 450.dp
    val maxSidePx = with(androidx.compose.ui.platform.LocalDensity.current) {
        maxOf(maxW, maxH).roundToPx()
    }
    val bitmap = rememberCachedImage(path, maxSidePx)
    val tokens = Velta.tokens
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
