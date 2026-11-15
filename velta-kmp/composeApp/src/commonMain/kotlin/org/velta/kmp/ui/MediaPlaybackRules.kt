package org.velta.kmp.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

// #334 step 11: media playback rules, ported from stable's
// audio-player.js, video-pos.js, ui.js openVideoLightbox and the
// composer's voice recorder (chat-view.js _recordVoice).

/** format.js formatDuration: "mm:ss", or "h:mm:ss" from an hour. */
fun formatDurationSec(seconds: Long): String {
    val t = seconds.coerceAtLeast(0)
    val h = t / 3600
    val m = (t % 3600) / 60
    val s = t % 60
    fun p2(n: Long) = n.toString().padStart(2, '0')
    return if (h > 0) "$h:${p2(m)}:${p2(s)}" else "${p2(m)}:${p2(s)}"
}

// ---- audio / voice bar (audio-player.js) ----

/** Voice/audio speeds; the small chip cycles 1× → 1.5× → 2×. */
val VOICE_SPEEDS = listOf(1f, 1.5f, 2f)
const val VOICE_SPEED_KEY = "velta-voice-speed"

fun storedVoiceSpeed(raw: String?): Float = raw?.toFloatOrNull()?.takeIf { it in VOICE_SPEEDS } ?: 1f

fun nextVoiceSpeed(v: Float): Float = VOICE_SPEEDS[(VOICE_SPEEDS.indexOf(v) + 1).mod(VOICE_SPEEDS.size)]

/** "1×", "1.5×", "0.5×" (JS prints numbers without a trailing .0). */
fun speedLabel(v: Float): String {
    val s = if (v == v.toLong().toFloat()) v.toLong().toString() else v.toString()
    return "$s×"
}

/** "00:03 / 00:04"; an unknown total reads "--:--". */
fun audioTimeLabel(currentMs: Long, totalMs: Long): String =
    formatDurationSec(currentMs / 1000) + " / " + (if (totalMs > 0) formatDurationSec(totalMs / 1000) else "--:--")

// ---- video lightbox (ui.js + video-pos.js) ----

val VIDEO_RATES = listOf(0.5f, 1f, 1.25f, 1.5f, 2f)
const val VIDEO_RATE_KEY = "velta-video-rate"
const val VIDEO_POS_KEY = "velta-video-pos"

fun savedVideoRate(raw: String?): Float = raw?.toFloatOrNull()?.takeIf { it in VIDEO_RATES } ?: 1f

/** A saved position worth resuming at: under 1 s or in the last two
 *  seconds counts as "start over" (0). */
fun videoResumeSeconds(saved: Long?, durationSec: Long): Long {
    val t = saved ?: return 0
    if (t < 1) return 0
    if (durationSec > 0 && t >= durationSec - 2) return 0
    return t
}

/** Insert/refresh [key] last (newest), drop it when [seconds] < 1, and
 *  keep at most [cap] entries (oldest first out). */
fun rememberVideoPos(map: Map<String, Long>, key: String, seconds: Long, cap: Int = 40): Map<String, Long> {
    val next = LinkedHashMap<String, Long>()
    for ((k, v) in map) if (k != key) next[k] = v
    if (key.isNotEmpty() && seconds >= 1) next[key] = seconds
    while (next.size > cap) next.remove(next.keys.first())
    return next
}

fun parseVideoPos(raw: String?): Map<String, Long> {
    if (raw.isNullOrBlank()) return emptyMap()
    return runCatching {
        val obj = Json.parseToJsonElement(raw) as? JsonObject ?: return emptyMap()
        val out = LinkedHashMap<String, Long>()
        for ((k, v) in obj) (v as? JsonPrimitive)?.longOrNull?.let { out[k] = it }
        out
    }.getOrDefault(emptyMap())
}

fun encodeVideoPos(map: Map<String, Long>): String =
    JsonObject(map.mapValues { JsonPrimitive(it.value) }).toString()

/** Stretch = object-fit: cover — the factor that grows a fitted picture
 *  until it fills the stage. */
fun coverScale(stageW: Float, stageH: Float, videoW: Float, videoH: Float): Float {
    if (stageW <= 0f || stageH <= 0f || videoW <= 0f || videoH <= 0f) return 1f
    val fit = minOf(stageW / videoW, stageH / videoH)
    val cover = maxOf(stageW / videoW, stageH / videoH)
    return cover / fit
}

// ---- voice recording (chat-view.js _recordVoice / _sendVoiceFile) ----

/** "voice-<ms>.m4a" — Android records AAC in MPEG-4 (stable's first pick). */
fun voiceFileName(nowMs: Long, ext: String = "m4a"): String = "voice-$nowMs.$ext"

/** Why a recording could not start → stable's toast text. */
fun voiceStartError(error: String): String = when (error) {
    VOICE_DENIED -> L.t("Microphone access is blocked. Enable it in system settings, then try again.")
    VOICE_UNAVAILABLE -> L.t("Voice recording isn't available here")
    else -> L.t("Couldn't start recording: ") + error
}

const val VOICE_DENIED = "denied"
const val VOICE_UNAVAILABLE = "unavailable"
