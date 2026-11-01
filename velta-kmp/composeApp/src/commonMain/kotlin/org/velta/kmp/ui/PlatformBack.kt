package org.velta.kmp.ui

import androidx.compose.runtime.Composable

/** Hooks the platform back gesture (Android) while a chat view is open. */
@Composable
expect fun PlatformBackHandler(onBack: () -> Unit)
