package org.velta.kmp.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Rounded-rect signed distance. Same shape as the web lens and the rust-ui
 * glass shader: negative inside, 0 on the rim, positive outside.
 */
internal fun glassSignedDistance(x: Float, y: Float, halfW: Float, halfH: Float, radius: Float): Float {
    val qx = abs(x) - halfW + radius
    val qy = abs(y) - halfH + radius
    return hypot(max(qx, 0f), max(qy, 0f)) + min(max(qx, qy), 0f) - radius
}

/** 1 on the rim, 0 once [distance] is [zone] px inside. Smoothstep. */
internal fun glassRim(distance: Float, zone: Float): Float {
    val u = ((-distance) / zone).coerceIn(0f, 1f)
    val s = u * u * (3f - 2f * u)
    return 1f - s
}

/**
 * Records [content] into one backdrop layer and draws [overlay] after it,
 * so a plate can sample the pixels underneath.
 * ponytail: the whole list is re-recorded every frame. Clip the snapshot
 * to the plates if scroll jank shows up.
 */
@Composable
internal fun GlassHost(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
    overlay: @Composable BoxScope.(GraphicsLayer, Offset) -> Unit,
) {
    val backdrop = rememberGraphicsLayer()
    var host by remember { mutableStateOf(Offset.Zero) }
    Box(modifier.onGloballyPositioned { host = it.positionInRoot() }) {
        Box(
            Modifier.fillMaxSize().drawWithContent {
                val w = size.width.toInt()
                val h = size.height.toInt()
                if (w > 0 && h > 0) {
                    backdrop.record(size = IntSize(w, h)) {
                        this@drawWithContent.drawContent()
                    }
                }
                drawLayer(backdrop)
            },
        ) {
            content()
        }
        overlay(backdrop, host)
    }
}

@Composable
internal expect fun GlassPlate(
    backdrop: GraphicsLayer,
    hostInRoot: Offset,
    modifier: Modifier = Modifier,
    radius: Dp = 22.dp,
    lens: Boolean = true,
    content: @Composable () -> Unit,
)
