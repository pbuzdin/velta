package org.velta.kmp.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier

/** Desktop has no in-app video engine (videoInApp stays false; videos go
 *  to the system player). Should it ever be shown, it reports failure. */
@Composable
actual fun VideoSurface(path: String, control: VideoControl, stretch: Boolean, modifier: Modifier) {
    LaunchedEffect(path) { control.failed = true }
}
