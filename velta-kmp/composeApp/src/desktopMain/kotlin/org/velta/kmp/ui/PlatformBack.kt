package org.velta.kmp.ui

import androidx.compose.runtime.Composable

/** Desktop has no back gesture — the ‹ Back button in the app bar covers it. */
@Composable
actual fun PlatformBackHandler(onBack: () -> Unit) {
}
