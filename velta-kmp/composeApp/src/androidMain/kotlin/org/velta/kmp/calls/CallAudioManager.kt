package org.velta.kmp.calls

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager

/**
 * Call audio: transient audio focus (a music player pauses), in-call mode
 * (routing to the earpiece / wired headset), loudspeaker toggle. Ports the
 * semantics of the Tauri side's `CallAudio.kt` (`call_audio_*` commands) to
 * plain Kotlin for the KMP client.
 */
object CallAudioManager {

    private var focusRequest: AudioFocusRequest? = null
    private var contextRef: Context? = null

    fun start(context: Context) {
        val appContext = context.applicationContext
        contextRef = appContext
        val am = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.mode = AudioManager.MODE_IN_CALL
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioFocusRequest.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .build()
            focusRequest = request
            am.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        }
    }

    fun stop(context: Context) {
        val appContext = context.applicationContext
        val am = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        focusRequest?.let { if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) am.abandonAudioFocusRequest(it) }
        focusRequest = null
        am.mode = AudioManager.MODE_NORMAL
        am.isSpeakerphoneOn = false
        contextRef = null
    }

    /** Loudspeaker on/off (earpiece is the default route for a 1:1 call). */
    fun toggleSpeaker(context: Context): Boolean {
        val am = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.isSpeakerphoneOn = !am.isSpeakerphoneOn
        return am.isSpeakerphoneOn
    }

    /** Wired/bluetooth headset connected → no speaker default (route by unplug). */
    fun wiredHeadset(context: Context): Boolean {
        val am = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val devices = am.getDevices(AudioManager.GET_DEVICES_INPUTS or AudioManager.GET_DEVICES_OUTPUTS)
        return devices.any {
            it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
        }
    }
}
