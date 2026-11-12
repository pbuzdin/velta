package org.velta.kmp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.unit.Dp

@Composable
@Suppress("UNUSED_PARAMETER")
internal actual fun GlassPlate(
    backdrop: GraphicsLayer,
    hostInRoot: Offset,
    modifier: Modifier,
    radius: Dp,
    lens: Boolean,
    content: @Composable () -> Unit,
) {
    val plate = MaterialTheme.colorScheme.surface
    Box(modifier) {
        Box(
            Modifier
                .matchParentSize()
                .background(if (lens) plate.copy(alpha = 0.88f) else plate),
        )
        content()
    }
}
