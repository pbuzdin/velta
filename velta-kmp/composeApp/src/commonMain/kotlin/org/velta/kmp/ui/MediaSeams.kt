package org.velta.kmp.ui

/** Platform audio output for the chat's voice/audio bar (Android
 *  MediaPlayer). One file at a time; the model owns which message it is. */
interface AudioEngine {
    /** Load [path] if it is not the current file, seek to [fromMs], set
     *  [rate] and play. [onEnd] runs when the file finished, [onError] when
     *  it cannot be played. False = could not start. */
    fun start(path: String, fromMs: Long, rate: Float, onEnd: () -> Unit, onError: (String) -> Unit): Boolean
    fun pause()
    fun seek(ms: Long)
    fun setRate(rate: Float)
    fun positionMs(): Long
    /** 0 while unknown. */
    fun durationMs(): Long
    fun release()
}

/** Platform microphone recorder for voice messages (Android MediaRecorder,
 *  AAC in .m4a). */
interface VoiceRecorder {
    /** Ask for the microphone if needed and start recording into a new
     *  file. Returns its path; throws with [VOICE_DENIED] /
     *  [VOICE_UNAVAILABLE] or another message when it cannot start. */
    suspend fun start(fileName: String): String
    /** Stop; true when the file holds audio. */
    fun stop(): Boolean
    /** Stop and delete the file. */
    fun cancel()
}
