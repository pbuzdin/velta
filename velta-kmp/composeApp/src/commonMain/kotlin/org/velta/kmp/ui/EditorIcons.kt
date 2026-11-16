package org.velta.kmp.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * Icons for the pre-send image editor (#334). VeltaIcons is generated from
 * app/js/icons.js, which has no crop/rotate/brush/undo/redo yet, so these
 * live here in the same house style: 24 grid, outline, stroke 2, round
 * caps + joins, black ink tinted by Icon().
 */
object EditorIcons {
    private fun strokeIcon(name: String, vararg paths: String): ImageVector =
        ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            for (d in paths) {
                addPath(
                    pathData = addPathNodes(d),
                    stroke = SolidColor(Color(0xFF000000)),
                    strokeLineWidth = 2f,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()

    val crop: ImageVector by lazy { strokeIcon("EditorIcons.Crop", "M6 2v14a2 2 0 0 0 2 2h14", "M18 22V8a2 2 0 0 0-2-2H2") }
    val rotate: ImageVector by lazy { strokeIcon("EditorIcons.Rotate", "M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5") }
    val brush: ImageVector by lazy {
        strokeIcon(
            "EditorIcons.Brush",
            "M9.1 11.5l9.4-9.4a2.1 2.1 0 0 1 3 3l-9.4 9.4",
            "M7 14c-2 0-3 1.5-3 3s-1 2.5-2 3c3 1.5 8 1 8-3a3 3 0 0 0-3-3z",
        )
    }
    val undo: ImageVector by lazy { strokeIcon("EditorIcons.Undo", "M9 14L4 9l5-5", "M4 9h11a5 5 0 0 1 0 10h-3") }
    val redo: ImageVector by lazy { strokeIcon("EditorIcons.Redo", "M15 14l5-5-5-5", "M20 9H9a5 5 0 0 0 0 10h3") }
}
