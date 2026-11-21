package org.velta.kmp.ui

import android.provider.Settings
import androidx.activity.BackEventCompat
import androidx.activity.compose.BackHandler
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import kotlin.coroutines.cancellation.CancellationException

@Composable
actual fun PlatformBackHandler(enabled: Boolean, onBack: () -> Unit) {
    BackHandler(enabled = enabled, onBack = onBack)
}

@Composable
actual fun PlatformRootBackHandler(enabled: Boolean) {
    // #443: back at the root backgrounds the app instead of finishing it —
    // the standard messenger pattern (per-layer handlers keep walking layers).
    val activity = LocalContext.current as? android.app.Activity
    BackHandler(enabled = enabled && activity != null) { activity?.moveTaskToBack(true) }
}

actual val touchGesturesEnabled: Boolean = true

@Composable
actual fun PlatformPredictiveBackHandler(
    enabled: Boolean,
    onProgress: (progress: Float, fromLeftEdge: Boolean) -> Unit,
    onCancel: () -> Unit,
    onBack: (fromLeftEdge: Boolean?) -> Unit,
) {
    val progress by rememberUpdatedState(onProgress)
    val cancel by rememberUpdatedState(onCancel)
    val back by rememberUpdatedState(onBack)
    PredictiveBackHandler(enabled = enabled) { events ->
        var fromLeft: Boolean? = null
        try {
            events.collect { e ->
                val left = e.swipeEdge == BackEventCompat.EDGE_LEFT
                fromLeft = left
                progress(e.progress, left)
            }
            back(fromLeft)
        } catch (c: CancellationException) {
            cancel()
            throw c
        }
    }
}

@Composable
actual fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
}
