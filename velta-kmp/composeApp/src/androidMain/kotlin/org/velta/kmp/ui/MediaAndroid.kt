package org.velta.kmp.ui

import android.graphics.BitmapFactory
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap

actual fun decodeImage(path: String): ImageBitmap? =
    BitmapFactory.decodeFile(path)?.asImageBitmap()
