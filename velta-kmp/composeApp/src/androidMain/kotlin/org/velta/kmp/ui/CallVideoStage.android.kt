package org.velta.kmp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.velta.kmp.calls.CallMediaAndroid

/**
 * P2 video surfaces: remote fullscreen, local camera PiP (mirrored front).
 * Tracks come from the adapter's compose states; a sink attaches when the
 * track changes (tag-guarded) and releases with the view.
 */
@Composable
actual fun CallVideoStage(model: AppModel) {
    val media = model.callMedia as? CallMediaAndroid ?: return
    val remoteTrack = media.remoteVideoTrack
    val localTrack = media.localVideoTrack

    Box(Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                SurfaceViewRenderer(ctx).apply {
                    init(CallMediaAndroid.eglContext(), null)
                    setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
                    setEnableHardwareScaler(true)
                }
            },
            update = { renderer ->
                // Tag-guard: attach a sink once per track (recomposition-safe).
                if (remoteTrack != null && renderer.tag !== remoteTrack) {
                    renderer.tag = remoteTrack
                    remoteTrack.addSink(renderer)
                }
            },
            onRelease = { renderer ->
                remoteTrack?.removeSink(renderer)
                renderer.release()
            },
        )
        AndroidView(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .windowInsetsPadding(WindowInsets.statusBars)
                .padding(12.dp)
                .size(110.dp, 160.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Velta.tokens.bgHover),
            factory = { ctx ->
                SurfaceViewRenderer(ctx).apply {
                    init(CallMediaAndroid.eglContext(), null)
                    setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
                    setMirror(true)
                    setEnableHardwareScaler(true)
                }
            },
            update = { renderer ->
                if (localTrack != null && renderer.tag !== localTrack) {
                    renderer.tag = localTrack
                    localTrack.addSink(renderer)
                }
            },
            onRelease = { renderer ->
                localTrack?.removeSink(renderer)
                renderer.release()
            },
        )
    }
}
