package org.velta.kmp.ui

import androidx.compose.runtime.Composable

/** P2 video: remote video fullscreen + local PiP (androidMain renderers).
 *  Desktop has no call media (stub). */
@Composable
expect fun CallVideoStage(model: AppModel)
