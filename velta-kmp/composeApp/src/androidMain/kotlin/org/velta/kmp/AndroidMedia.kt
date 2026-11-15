package org.velta.kmp

import android.content.Context
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import org.velta.kmp.ui.AudioEngine
import org.velta.kmp.ui.VOICE_DENIED
import org.velta.kmp.ui.VoiceRecorder
import java.io.File

/** MediaPlayer behind the chat's audio/voice bar: one file at a time. */
class AndroidAudioEngine : AudioEngine {
    private var player: MediaPlayer? = null
    private var path: String? = null

    override fun start(path: String, fromMs: Long, rate: Float, onEnd: () -> Unit, onError: (String) -> Unit): Boolean {
        return try {
            val mp = if (this.path == path && player != null) {
                player!!
            } else {
                release()
                MediaPlayer().apply {
                    setDataSource(path)
                    prepare()
                }.also { player = it; this.path = path }
            }
            mp.setOnCompletionListener { onEnd() }
            mp.setOnErrorListener { _, what, extra -> onError("$what/$extra"); true }
            if (fromMs >= 0) mp.seekTo(fromMs.toInt())
            mp.start()
            setRate(rate)
            true
        } catch (t: Throwable) {
            release()
            false
        }
    }

    override fun pause() { runCatching { player?.pause() } }
    override fun seek(ms: Long) { runCatching { player?.seekTo(ms.toInt()) } }

    override fun setRate(rate: Float) {
        val mp = player ?: return
        if (Build.VERSION.SDK_INT < 23) return
        runCatching {
            val wasPlaying = mp.isPlaying
            mp.playbackParams = mp.playbackParams.setSpeed(rate)
            if (!wasPlaying) mp.pause()
        }
    }

    override fun positionMs(): Long = runCatching { player?.currentPosition?.toLong() }.getOrNull() ?: 0L
    override fun durationMs(): Long = runCatching { player?.duration?.toLong()?.takeIf { it > 0 } }.getOrNull() ?: 0L

    override fun release() {
        runCatching { player?.release() }
        player = null
        path = null
    }
}

/** MediaRecorder for voice messages: AAC in MPEG-4 (.m4a), mono 44.1 kHz.
 *  [askMic] asks for RECORD_AUDIO when needed and says if it was granted. */
class AndroidVoiceRecorder(
    private val context: Context,
    /** Re-pointed at the current activity after a recreate. */
    var askMic: suspend () -> Boolean,
) : VoiceRecorder {
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var startedAt = 0L

    override suspend fun start(fileName: String): String {
        if (!askMic()) throw IllegalStateException(VOICE_DENIED)
        val dir = File(context.cacheDir, "voice").apply { mkdirs() }
        val out = File(dir, fileName)
        @Suppress("DEPRECATION")
        val rec = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()
        try {
            rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setAudioChannels(1)
            rec.setAudioSamplingRate(44100)
            rec.setAudioEncodingBitRate(64000)
            rec.setOutputFile(out.absolutePath)
            rec.prepare()
            rec.start()
        } catch (t: Throwable) {
            runCatching { rec.release() }
            out.delete()
            throw IllegalStateException(t.message ?: t.toString())
        }
        recorder = rec
        file = out
        startedAt = System.currentTimeMillis()
        return out.absolutePath
    }

    override fun stop(): Boolean {
        val rec = recorder ?: return false
        recorder = null
        // MediaRecorder.stop() throws when nothing was captured (a tap-short
        // recording): that is stable's "recording was empty".
        val ok = runCatching { rec.stop() }.isSuccess
        runCatching { rec.release() }
        val f = file
        file = null
        return ok && f != null && f.length() > 0
    }

    override fun cancel() {
        val rec = recorder
        recorder = null
        if (rec != null) {
            runCatching { rec.stop() }
            runCatching { rec.release() }
        }
        file?.delete()
        file = null
    }
}
