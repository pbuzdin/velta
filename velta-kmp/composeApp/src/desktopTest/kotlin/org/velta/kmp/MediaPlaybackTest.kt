package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.MessageObject
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.AudioEngine
import org.velta.kmp.ui.VOICE_DENIED
import org.velta.kmp.ui.VoiceRecorder
import org.velta.kmp.ui.audioTimeLabel
import org.velta.kmp.ui.coverScale
import org.velta.kmp.ui.encodeVideoPos
import org.velta.kmp.ui.formatDurationSec
import org.velta.kmp.ui.nextVoiceSpeed
import org.velta.kmp.ui.parseVideoPos
import org.velta.kmp.ui.rememberVideoPos
import org.velta.kmp.ui.savedVideoRate
import org.velta.kmp.ui.speedLabel
import org.velta.kmp.ui.storedVoiceSpeed
import org.velta.kmp.ui.videoResumeSeconds
import org.velta.kmp.ui.voiceFileName
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #334 step 11: video lightbox, audio bar and voice recording rules. */
class MediaPlaybackTest {

    @Test
    fun durationsAndLabelsMatchStable() {
        assertEquals("00:07", formatDurationSec(7))
        assertEquals("01:05", formatDurationSec(65))
        assertEquals("1:00:01", formatDurationSec(3601))
        assertEquals("00:03 / 00:04", audioTimeLabel(3_400, 4_900))
        assertEquals("00:00 / --:--", audioTimeLabel(0, 0))
        assertEquals("1×", speedLabel(1f))
        assertEquals("1.5×", speedLabel(1.5f))
        assertEquals("0.5×", speedLabel(0.5f))
        assertEquals("voice-42.m4a", voiceFileName(42))
    }

    @Test
    fun speedsCycleAndPersistLikeStable() {
        assertEquals(1.5f, nextVoiceSpeed(1f))
        assertEquals(2f, nextVoiceSpeed(1.5f))
        assertEquals(1f, nextVoiceSpeed(2f))
        assertEquals(1.5f, storedVoiceSpeed("1.5"))
        assertEquals(1f, storedVoiceSpeed("3"))
        assertEquals(1f, storedVoiceSpeed(null))
        assertEquals(1.25f, savedVideoRate("1.25"))
        assertEquals(1f, savedVideoRate("7"))
    }

    @Test
    fun videoResumeRules() {
        assertEquals(0, videoResumeSeconds(null, 100))
        assertEquals(0, videoResumeSeconds(0, 100))
        assertEquals(40, videoResumeSeconds(40, 100))
        assertEquals(0, videoResumeSeconds(98, 100)) // last two seconds = finished
        assertEquals(40, videoResumeSeconds(40, 0)) // unknown duration
        var m = mapOf("a" to 5L, "b" to 6L)
        m = rememberVideoPos(m, "a", 9)
        assertEquals(listOf("b", "a"), m.keys.toList()) // refreshed key goes last
        m = rememberVideoPos(m, "b", 0)
        assertEquals(listOf("a"), m.keys.toList())
        val many = (1..45).fold(emptyMap<String, Long>()) { acc, i -> rememberVideoPos(acc, "k$i", 3) }
        assertEquals(40, many.size)
        assertFalse("k1" in many)
        assertEquals(mapOf("a" to 9L), parseVideoPos(encodeVideoPos(mapOf("a" to 9L))))
        assertEquals(emptyMap(), parseVideoPos("not json"))
    }

    @Test
    fun coverScaleFillsTheStage() {
        assertEquals(1f, coverScale(100f, 100f, 0f, 0f))
        // 16:9 video in a 9:16 stage: fit by width, cover needs (16/9)^2.
        val s = coverScale(900f, 1600f, 1600f, 900f)
        assertTrue(kotlin.math.abs(s - (1600f / 900f) * (1600f / 900f)) < 0.01f, "$s")
    }

    // ---- model ----

    private class FakeEngine : AudioEngine {
        val calls = mutableListOf<String>()
        var pos = 0L
        var onEnd: (() -> Unit)? = null
        override fun start(path: String, fromMs: Long, rate: Float, onEnd: () -> Unit, onError: (String) -> Unit): Boolean {
            calls += "start $path $fromMs $rate"; this.onEnd = onEnd; return true
        }
        override fun pause() { calls += "pause" }
        override fun seek(ms: Long) { calls += "seek $ms"; pos = ms }
        override fun setRate(rate: Float) { calls += "rate $rate" }
        override fun positionMs() = pos
        override fun durationMs() = 4_000L
        override fun release() { calls += "release" }
    }

    private class FakeRecorder(val deny: Boolean = false, val audio: Boolean = true) : VoiceRecorder {
        var cancelled = false
        override suspend fun start(fileName: String): String {
            if (deny) throw IllegalStateException(VOICE_DENIED)
            return "/tmp/$fileName"
        }
        override fun stop() = audio
        override fun cancel() { cancelled = true }
    }

    private class Prefs : HashMap<String, String>()

    private fun transport() = ScriptedRpcTransport(
        mapOf(
            "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
            "get_all_account_ids" to "[1]",
            "get_selected_account_id" to "1",
            "get_account_info" to """{"id":1,"addr":"a@example.org","isConfigured":true}""",
            "get_all_accounts" to """[{"id":1,"addr":"a@example.org","isConfigured":true}]""",
            "select_account" to "null",
            "start_io_for_all_accounts" to "null",
            "get_chatlist_entries" to "[5]",
            "get_chatlist_items_by_entries" to
                """{"5":{"kind":"ChatListItem","id":5,"name":"Test Chat","summaryText2":"x","lastUpdated":1,"freshMessageCounter":0}}""",
            "get_message_ids" to "[]",
            "misc_set_draft" to "null",
            "remove_draft" to "null",
            "list_transports" to """[{"addr":"a@example.org"}]""",
            "get_server_metadata" to "{}",
            "misc_get_stickers" to "{}",
            "send_msg" to "77",
            "get_messages" to "{}",
        ),
    )

    private suspend fun until(cond: () -> Boolean) = withTimeout(10_000) { while (!cond()) delay(10) }

    private fun run(t: ScriptedRpcTransport, prefs: Prefs = Prefs(), block: suspend (AppModel) -> Unit) = runBlocking {
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-media-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = t
            override fun pref(key: String): String? = prefs[key]
            override fun setPref(key: String, value: String?) { if (value == null) prefs.remove(key) else prefs[key] = value }
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(platform, scope)
        try {
            model.connect()
            until { model.screen == AppModel.Screen.ChatList && model.chats.isNotEmpty() }
            block(model)
        } finally {
            scope.cancel()
        }
    }

    private val voice = MessageObject(id = 9, chatId = 5, viewType = "Voice", file = "/b/v.m4a", duration = 4_000, fromId = 2)

    @Test
    fun audioBarPlaysPausesSeeksAndCyclesSpeed() {
        val prefs = Prefs()
        run(transport(), prefs) { m ->
            val engine = FakeEngine()
            m.audioEngine = engine
            m.toggleAudio(voice)
            until { m.audioNow?.playing == true }
            assertEquals("start /b/v.m4a 0 1.0", engine.calls.last())
            m.cycleVoiceSpeed()
            assertEquals(1.5f, m.voiceSpeed)
            assertEquals("1.5", prefs["velta-voice-speed"])
            assertEquals("rate 1.5", engine.calls.last())
            m.seekAudio(voice, 2_000)
            assertEquals("seek 2000", engine.calls.last())
            m.toggleAudio(voice)
            assertFalse(m.audioNow!!.playing)
            assertEquals(2_000, m.audioNow!!.posMs)
            m.toggleAudio(voice)
            assertEquals("start /b/v.m4a 2000 1.5", engine.calls.last())
            engine.onEnd!!.invoke()
            assertFalse(m.audioNow!!.playing)
            assertEquals(0, m.audioNow!!.posMs) // stable: ended rewinds
            m.backToChatList()
            assertNull(m.audioNow)
        }
    }

    @Test
    fun videoTapOpensTheInAppPlayerAndRemembersRateAndPosition() {
        val prefs = Prefs()
        run(transport(), prefs) { m ->
            m.videoInApp = true
            m.tapVideo(MessageObject(id = 11, viewType = "Video", file = "/b/clip.mp4", fileName = "clip.mp4", fromId = 2))
            until { m.videoBox != null }
            assertEquals(AppModel.VideoBox("/b/clip.mp4", "clip.mp4"), m.videoBox)
            m.setVideoRateChoice(1.25f)
            assertEquals("1.25", prefs["velta-video-rate"])
            m.saveVideoPosition("/b/clip.mp4", 30, 100)
            assertEquals(30, m.videoResumeAt("/b/clip.mp4", 100))
            m.saveVideoPosition("/b/clip.mp4", 0, 100) // a pause under 1 s keeps the bookmark
            assertEquals(30, m.videoResumeAt("/b/clip.mp4", 100))
            m.saveVideoPosition("/b/clip.mp4", 99, 100) // finished → forgotten
            assertEquals(0, m.videoResumeAt("/b/clip.mp4", 100))
        }
    }

    @Test
    fun voiceRecordingSendsAVoiceMessageWithTheQuote() {
        val t = transport()
        run(t) { m ->
            m.openChat(m.chats.first())
            until { m.screen is AppModel.Screen.Chat }
            m.voiceRecorder = FakeRecorder()
            m.replyTo = MessageObject(id = 3, text = "q")
            m.startVoice()
            until { m.voiceRec != null }
            m.stopVoice(true)
            assertNull(m.voiceRec)
            until { t.requests.any { "\"send_msg\"" in it } }
            val line = t.requests.first { "\"send_msg\"" in it }
            assertTrue(line.contains("\"viewtype\":\"Voice\""), line)
            assertTrue(line.contains("\"file\":\"/tmp/voice-"), line)
            assertTrue(line.contains("\"quotedMessageId\":3"), line)
            assertNull(m.replyTo)
        }
    }

    @Test
    fun voiceRecordingCancelDeniedAndEmpty() {
        run(transport()) { m ->
            m.openChat(m.chats.first())
            until { m.screen is AppModel.Screen.Chat }
            val rec = FakeRecorder()
            m.voiceRecorder = rec
            m.startVoice()
            until { m.voiceRec != null }
            m.stopVoice(false)
            assertTrue(rec.cancelled)
            m.voiceRecorder = FakeRecorder(deny = true)
            m.startVoice()
            until { m.toast != null }
            assertEquals("Microphone access is blocked. Enable it in system settings, then try again.", m.toast)
            m.voiceRecorder = FakeRecorder(audio = false)
            m.startVoice()
            until { m.voiceRec != null }
            m.stopVoice(true)
            assertEquals("Couldn't send voice message: recording was empty", m.toast)
        }
    }
}
