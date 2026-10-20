package org.velta

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.annotation.RequiresApi

/**
 * #141: audio route for WebRTC calls in the WebView (app/js/calls.js).
 *
 * Called from lib.rs (call_audio_start / call_audio_speaker /
 * call_audio_stop) through the cached-class JNI pattern, like Battery and
 * UnifiedPushBridge. Every entry returns the route actually in use:
 * "earpiece", "speaker", "wired", "usb", "bluetooth" (or "none").
 *
 * - start: MODE_IN_COMMUNICATION + voice-call audio focus, then the route.
 *   The default (speaker = false) is the EARPIECE, but a connected wired /
 *   USB / Bluetooth headset wins over it. The WebView switches the audio
 *   mode itself when the capture starts (Chromium's AudioManagerAndroid,
 *   which picks the loudspeaker), so the page calls this AFTER getUserMedia.
 * - setSpeaker(true) = loudspeaker; setSpeaker(false) = headset or earpiece.
 * - `auto` (call start, camera on/off): a connected headset keeps the audio
 *   even when the loudspeaker is asked for (video calls default to the
 *   loudspeaker, but not over a headset). A tap on Speaker is not auto.
 * - stop: clear the device, speakerphone off, MODE_NORMAL, focus abandoned.
 *   Always MODE_NORMAL — not "the saved mode": by the time start runs the
 *   WebView has already put the mode into IN_COMMUNICATION.
 *
 * While the route is the earpiece, a PROXIMITY_SCREEN_OFF_WAKE_LOCK turns
 * the screen off at the ear (no cheek taps on End call). A device callback
 * re-applies the chosen route when a headset is plugged in or removed.
 */
object CallAudio {
    private const val TAG = "VeltaCallAudio"
    private val main = Handler(Looper.getMainLooper())

    private var active = false
    private var speaker = false
    private var auto = true
    private var route = "none"
    private var focusRequest: AudioFocusRequest? = null
    private var proximity: PowerManager.WakeLock? = null
    private var deviceCallback: AudioDeviceCallback? = null
    private var scoStarted = false

    private fun am(context: Context) = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    @JvmStatic
    @Synchronized
    fun start(context: Context, speakerOn: Boolean, autoRoute: Boolean): String {
        val am = am(context)
        speaker = speakerOn
        auto = autoRoute
        if (!active) {
            active = true
            requestFocus(am)
            registerDeviceCallback(context, am)
        }
        try {
            am.mode = AudioManager.MODE_IN_COMMUNICATION
        } catch (e: Throwable) {
            Log.w(TAG, "setMode(IN_COMMUNICATION) failed", e)
        }
        apply(context, am)
        Log.i(TAG, "start speaker=$speaker route=$route mode=${am.mode}")
        return route
    }

    @JvmStatic
    @Synchronized
    fun setSpeaker(context: Context, on: Boolean, autoRoute: Boolean): String {
        speaker = on
        auto = autoRoute
        if (!active) return start(context, on, autoRoute)
        val am = am(context)
        // The WebView may have dropped the mode back meanwhile; re-assert.
        if (am.mode != AudioManager.MODE_IN_COMMUNICATION) {
            try { am.mode = AudioManager.MODE_IN_COMMUNICATION } catch (_: Throwable) {}
        }
        apply(context, am)
        Log.i(TAG, "setSpeaker on=$on auto=$autoRoute route=$route mode=${am.mode}")
        return route
    }

    @JvmStatic
    @Synchronized
    @Suppress("DEPRECATION")
    fun stop(context: Context) {
        val am = am(context)
        unregisterDeviceCallback(am)
        releaseProximity()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try { am.clearCommunicationDevice() } catch (e: Throwable) { Log.w(TAG, "clearCommunicationDevice failed", e) }
        }
        stopSco(am)
        try { am.isSpeakerphoneOn = false } catch (_: Throwable) {}
        try { am.mode = AudioManager.MODE_NORMAL } catch (e: Throwable) { Log.w(TAG, "setMode(NORMAL) failed", e) }
        abandonFocus(am)
        active = false
        speaker = false
        route = "none"
        Log.i(TAG, "stop mode=${am.mode}")
    }

    // ---- routing ----

    private fun apply(context: Context, am: AudioManager) {
        route = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) applyModern(am) else applyLegacy(am)
        if (route == "earpiece") acquireProximity(context) else releaseProximity()
    }

    private val headsetTypes = listOf(
        AudioDeviceInfo.TYPE_WIRED_HEADSET to "wired",
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES to "wired",
        AudioDeviceInfo.TYPE_USB_HEADSET to "usb",
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO to "bluetooth",
    )

    // API 31+: setCommunicationDevice picks the device for the
    // communication strategy (what the WebRTC stream plays through).
    @RequiresApi(Build.VERSION_CODES.S)
    @Suppress("DEPRECATION")
    private fun applyModern(am: AudioManager): String {
        val devices = try { am.availableCommunicationDevices } catch (e: Throwable) { emptyList() }
        val autoHeadset = if (speaker && auto) headsetPick(devices) else null
        val pick: Pair<AudioDeviceInfo, String>? = if (autoHeadset != null) {
            autoHeadset
        } else if (speaker) {
            devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }?.let { it to "speaker" }
        } else {
            val headset = headsetPick(devices)
            headset ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }?.let { it to "earpiece" }
        }
        if (pick == null) {
            Log.w(TAG, "no communication device for speaker=$speaker; have " + devices.joinToString { "${it.type}" })
            am.isSpeakerphoneOn = speaker
            return if (speaker) "speaker" else "none"
        }
        val ok = try { am.setCommunicationDevice(pick.first) } catch (e: Throwable) { Log.w(TAG, "setCommunicationDevice failed", e); false }
        if (!ok) Log.w(TAG, "setCommunicationDevice(${pick.second}) refused")
        return pick.second
    }

    private fun headsetPick(devices: List<AudioDeviceInfo>): Pair<AudioDeviceInfo, String>? {
        for ((type, name) in headsetTypes) {
            devices.firstOrNull { it.type == type }?.let { return it to name }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLE_HEADSET }?.let { return it to "bluetooth" }
        }
        return null
    }

    // API 24-30: speakerphone flag; a wired headset takes over by itself
    // when the speakerphone is off; Bluetooth needs SCO.
    @Suppress("DEPRECATION")
    private fun applyLegacy(am: AudioManager): String {
        val outs = try { am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList() } catch (_: Throwable) { emptyList() }
        val headsetOut = outs.any {
            it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                it.type == AudioDeviceInfo.TYPE_USB_HEADSET || it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
        }
        if (speaker && !(auto && headsetOut)) {
            stopSco(am)
            am.isSpeakerphoneOn = true
            return "speaker"
        }
        am.isSpeakerphoneOn = false
        if (outs.any { it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES }) {
            stopSco(am)
            return "wired"
        }
        if (outs.any { it.type == AudioDeviceInfo.TYPE_USB_HEADSET }) {
            stopSco(am)
            return "usb"
        }
        if (outs.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO } && am.isBluetoothScoAvailableOffCall) {
            try {
                am.startBluetoothSco()
                am.isBluetoothScoOn = true
                scoStarted = true
                return "bluetooth"
            } catch (e: Throwable) {
                Log.w(TAG, "startBluetoothSco failed", e)
            }
        }
        stopSco(am)
        return "earpiece"
    }

    @Suppress("DEPRECATION")
    private fun stopSco(am: AudioManager) {
        if (!scoStarted) return
        scoStarted = false
        try { am.isBluetoothScoOn = false; am.stopBluetoothSco() } catch (_: Throwable) {}
    }

    // ---- focus ----

    @Suppress("DEPRECATION")
    private fun requestFocus(am: AudioManager) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build(),
                    )
                    .build()
                focusRequest = req
                am.requestAudioFocus(req)
            } else {
                am.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "requestAudioFocus failed", e)
        }
    }

    @Suppress("DEPRECATION")
    private fun abandonFocus(am: AudioManager) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                focusRequest?.let { am.abandonAudioFocusRequest(it) }
            } else {
                am.abandonAudioFocus(null)
            }
        } catch (_: Throwable) {}
        focusRequest = null
    }

    // ---- headset plug / unplug ----

    private fun registerDeviceCallback(context: Context, am: AudioManager) {
        if (deviceCallback != null) return
        val app = context.applicationContext
        val cb = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = reapply(app)
            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = reapply(app)
        }
        deviceCallback = cb
        try { am.registerAudioDeviceCallback(cb, main) } catch (e: Throwable) { Log.w(TAG, "registerAudioDeviceCallback failed", e) }
    }

    private fun unregisterDeviceCallback(am: AudioManager) {
        deviceCallback?.let { try { am.unregisterAudioDeviceCallback(it) } catch (_: Throwable) {} }
        deviceCallback = null
    }

    @Synchronized
    private fun reapply(context: Context) {
        if (!active) return
        auto = true // a plugged-in headset takes the audio
        apply(context, am(context))
        Log.i(TAG, "devices changed: route=$route")
    }

    // ---- proximity (earpiece only) ----

    private fun acquireProximity(context: Context) {
        if (proximity?.isHeld == true) return
        try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
            val lock = proximity ?: pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "velta:call-proximity")
            lock.setReferenceCounted(false)
            // Ceiling only (a forgotten stop must not keep it forever).
            lock.acquire(4 * 60 * 60 * 1000L)
            proximity = lock
        } catch (e: Throwable) {
            Log.w(TAG, "proximity wake lock failed", e)
        }
    }

    private fun releaseProximity() {
        try {
            proximity?.let { if (it.isHeld) it.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY) }
        } catch (_: Throwable) {}
    }
}
