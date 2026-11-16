package org.velta.kmp.ui

import androidx.compose.runtime.Composable

/** Desktop has no back gesture — the ‹ Back button in the app bar covers it. */
@Composable
actual fun PlatformBackHandler(enabled: Boolean, onBack: () -> Unit) {
}

/** Desktop mice don't swipe (web _mobileGestures gates to coarse pointers). */
actual val touchGesturesEnabled: Boolean = false

@Composable
actual fun PlatformPredictiveBackHandler(
    enabled: Boolean,
    onProgress: (progress: Float, fromLeftEdge: Boolean) -> Unit,
    onCancel: () -> Unit,
    onBack: (fromLeftEdge: Boolean?) -> Unit,
) {
}

@Composable
actual fun rememberReducedMotion(): Boolean = false
