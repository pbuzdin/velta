package org.velta.kmp.ui

import androidx.compose.runtime.Composable

/** Hooks the platform back gesture (Android) while a chat view is open.
 * `enabled = false` lets the default (exit) through. */
@Composable
expect fun PlatformBackHandler(enabled: Boolean = true, onBack: () -> Unit)
