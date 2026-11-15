package org.velta.kmp.ui

import android.media.MediaPlayer
import android.os.Build
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.VideoView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay

private fun MediaPlayer.applySpeed(rate: Float) {
    if (Build.VERSION.SDK_INT < 23) return
    runCatching {
        val wasPlaying = isPlaying
        playbackParams = playbackParams.setSpeed(rate)
        // setPlaybackParams starts a paused player; keep it paused.
        if (!wasPlaying) pause()
    }
}

private fun applyCover(frame: FrameLayout, control: VideoControl) {
    val video = frame.getChildAt(0) ?: return
    val s = if (frame.tag == true) {
        coverScale(frame.width.toFloat(), frame.height.toFloat(), control.videoW.toFloat(), control.videoH.toFloat())
    } else 1f
    video.scaleX = s
    video.scaleY = s
}

/** VideoView in a centering frame. Stretch scales the view to cover the
 *  frame (aspect kept; the frame clips). */
@Composable
actual fun VideoSurface(path: String, control: VideoControl, stretch: Boolean, modifier: Modifier) {
    val holder = remember(path) { arrayOfNulls<MediaPlayer>(1) }
    LaunchedEffect(path) {
        while (true) {
            delay(250)
            val mp = holder[0] ?: continue
            runCatching { if (mp.isPlaying) control.posMs = mp.currentPosition.toLong() }
        }
    }
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            val frame = FrameLayout(ctx)
            val video = VideoView(ctx)
            frame.addView(video, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER))
            video.setOnPreparedListener { mp ->
                holder[0] = mp
                control.durMs = mp.duration.toLong().coerceAtLeast(0)
                control.videoW = mp.videoWidth
                control.videoH = mp.videoHeight
                // Stable loadedmetadata: resume unless the bookmark is at the end.
                val start = videoResumeSeconds(control.startMs / 1000, control.durMs / 1000) * 1000
                if (start > 0) video.seekTo(start.toInt())
                control.posMs = start
                applyCover(frame, control)
                video.start()
                mp.applySpeed(control.rate)
                control.playing = true
            }
            video.setOnCompletionListener {
                control.playing = false
                control.posMs = control.durMs
            }
            video.setOnErrorListener { _, _, _ ->
                control.playing = false
                control.failed = true
                true
            }
            control.onPlay = {
                if (control.durMs > 0 && control.posMs >= control.durMs - 250) video.seekTo(0)
                video.start()
                holder[0]?.applySpeed(control.rate)
                control.playing = true
            }
            control.onPause = {
                video.pause()
                control.posMs = video.currentPosition.toLong()
                control.playing = false
            }
            control.onSeek = { ms -> video.seekTo(ms.toInt()) }
            control.onRate = { r -> holder[0]?.applySpeed(r) }
            frame.addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ -> applyCover(v as FrameLayout, control) }
            video.setVideoPath(path)
            frame
        },
        update = { frame ->
            frame.tag = stretch
            applyCover(frame, control)
        },
        onRelease = { frame ->
            holder[0] = null
            (frame.getChildAt(0) as? VideoView)?.stopPlayback()
        },
    )
}
