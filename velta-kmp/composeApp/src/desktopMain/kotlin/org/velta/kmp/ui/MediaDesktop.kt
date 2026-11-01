package org.velta.kmp.ui

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import java.io.File
import javax.imageio.ImageIO

actual fun decodeImage(path: String): ImageBitmap? =
    runCatching {
        ImageIO.read(File(path))?.toComposeImageBitmap()
    }.getOrNull()
