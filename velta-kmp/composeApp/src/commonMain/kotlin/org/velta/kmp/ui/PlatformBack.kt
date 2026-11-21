package org.velta.kmp.ui

import androidx.compose.runtime.Composable

/** Hooks the platform back gesture (Android) while a chat view is open.
 * `enabled = false` lets the default (exit) through. */
@Composable
expect fun PlatformBackHandler(enabled: Boolean = true, onBack: () -> Unit)

/** Touch-driven swipe gestures (web _mobileGestures: coarse pointer, phone
 *  form factor). Android = true; desktop mice don't swipe. */
expect val touchGesturesEnabled: Boolean


/**
 * Predictive back (Android 14+): [onProgress] gets the system progress
 * (0..1) and whether the swipe started at the left edge; [onCancel] when the
 * user lets go without committing; [onBack] on commit (edge null = button /
 * key back with no gesture). Older Android calls [onBack] straight away.
 * Desktop: no-op.
 */
@Composable
expect fun PlatformPredictiveBackHandler(
    enabled: Boolean = true,
    onProgress: (progress: Float, fromLeftEdge: Boolean) -> Unit,
    onCancel: () -> Unit,
    onBack: (fromLeftEdge: Boolean?) -> Unit,
)

/** #443: back on the root screen (plain chat list) backgrounds the app
 *  instead of finishing it. Desktop: no-op. */
@Composable
expect fun PlatformRootBackHandler(enabled: Boolean = true)

/** System "remove animations" (animator duration scale 0): gestures still
 *  work but follow the finger flat — no springs, pops, parallax or dim. */
@Composable
expect fun rememberReducedMotion(): Boolean
