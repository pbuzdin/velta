package org.velta.kmp.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Decode an image file into an ImageBitmap, or null if it can't be read. */
expect fun decodeImage(path: String): ImageBitmap?

/**
 * Renders a blob image (P4: media rendering). Decodes off the main thread;
 * falls back to a placeholder while loading or when undecodable.
 */
@Composable
fun MediaFromDisk(path: String, modifier: Modifier = Modifier) {
    var bitmap by remember(path) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(path) {
        bitmap = withContext(Dispatchers.IO) { decodeImage(path) }
    }
    val decoded = bitmap
    if (decoded != null) {
        Image(
            bitmap = decoded,
            contentDescription = null,
            contentScale = ContentScale.FillWidth,
            modifier = modifier
                .widthIn(max = 280.dp)
                .heightIn(max = 320.dp),
        )
    } else {
        Box(modifier.widthIn(max = 280.dp).heightIn(min = 60.dp), contentAlignment = Alignment.Center) {
            Text(
                "📷 …",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
