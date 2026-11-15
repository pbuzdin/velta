package org.velta.kmp.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private val LIGHTBOX_BG = Color(0xF5101010) // .lightbox rgba(16,16,16,.96)
private val LIGHTBOX_INK = Color(0xFFF4F4F4)

/**
 * Stable openImageLightbox (ui.js): full-screen viewer, caption + close in
 * the bar; pinch to zoom (1–8×), drag while zoomed, double tap toggles
 * 2.5×, a single tap at fit closes; BACK closes. Toasts stay on top.
 */
@Composable
internal fun ImageLightbox(model: AppModel) {
    val box = model.lightbox ?: return
    val close = { model.lightbox = null }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false),
    ) {
        Box(Modifier.fillMaxSize().background(LIGHTBOX_BG)) {
            Column(Modifier.fillMaxSize()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .windowInsetsPadding(WindowInsets.statusBars)
                        .padding(start = 14.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        box.caption,
                        fontSize = 14.sp,
                        color = LIGHTBOX_INK,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).alpha(0.85f),
                    )
                    IconButton(onClick = close) {
                        Icon(VeltaIcons.close, contentDescription = L.t("Close"), tint = LIGHTBOX_INK)
                    }
                }
                LightboxStage(box.path, onClose = close, modifier = Modifier.weight(1f).fillMaxWidth())
            }
            if (model.toast != null) {
                Box(
                    Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.navigationBars).padding(bottom = 24.dp),
                    contentAlignment = Alignment.BottomCenter,
                ) { ToastHost(model) }
            }
        }
    }
}

@Composable
private fun LightboxStage(path: String, onClose: () -> Unit, modifier: Modifier) {
    var bitmap by remember(path) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(path) { mutableStateOf(false) }
    LaunchedEffect(path) {
        val decoded = withContext(Dispatchers.IO) { decodeImage(path) }
        bitmap = decoded
        failed = decoded == null
    }
    var scale by remember(path) { mutableFloatStateOf(1f) }
    var offset by remember(path) { mutableStateOf(Offset.Zero) }
    Box(
        modifier
            .pointerInput(path) {
                detectTapGestures(
                    onDoubleTap = {
                        if (scale > 1f) { scale = 1f; offset = Offset.Zero } else scale = LIGHTBOX_DOUBLE_TAP_SCALE
                    },
                    onTap = { if (scale <= 1f) onClose() },
                )
            }
            .pointerInput(path) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = lightboxScale(scale * zoom)
                    offset = if (scale <= 1f) Offset.Zero else offset + pan
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        val b = bitmap
        when {
            b != null -> Image(
                bitmap = b,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize().graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    translationX = offset.x
                    translationY = offset.y
                },
            )
            failed -> Text(L.t("Could not open file: ") + path.substringAfterLast('/'), color = LIGHTBOX_INK, fontSize = 14.sp)
            else -> CircularProgressIndicator(color = LIGHTBOX_INK, modifier = Modifier.size(32.dp))
        }
    }
}
