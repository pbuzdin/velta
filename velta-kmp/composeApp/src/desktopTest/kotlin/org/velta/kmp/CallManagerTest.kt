package org.velta.kmp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.velta.kmp.core.CallCore
import org.velta.kmp.ui.CallEvent
import org.velta.kmp.ui.CallManager
import org.velta.kmp.ui.CallMedia
import org.velta.kmp.ui.CallState

/**
 * Headless exercise of the call signaling engine — the desktopTest port of
 * `tests/call-state-machine.test.mjs`: what the core methods fire with which
 * payloads, and the state transitions. Media is a fake; WebRTC is P1b.
 */
class CallManagerTest {

    private class FakeCallCore : CallCore {
        val placed = mutableListOf<Pair<Long, String>>()
        val accepted = mutableListOf<Pair<Long, String>>()
        val ended = mutableListOf<Long>()
        override suspend fun placeOutgoingCall(accountId: Long, chatId: Long, offerSdp: String, hasVideo: Boolean): Long {
            placed.add(chatId to offerSdp)
            return 4321L
        }
        override suspend fun acceptIncomingCall(accountId: Long, msgId: Long, answerSdp: String) {
            accepted.add(msgId to answerSdp)
        }
        override suspend fun endCall(accountId: Long, msgId: Long) { ended.add(msgId) }
        override suspend fun callInfo(accountId: Long, msgId: Long): kotlinx.serialization.json.JsonObject =
            kotlinx.serialization.json.buildJsonObject {
                put("sdpOffer", kotlinx.serialization.json.JsonPrimitive("remote-offer-sdp"))
                put("hasVideo", kotlinx.serialization.json.JsonPrimitive(false))
                put("state", kotlinx.serialization.json.JsonPrimitive("Ringing"))
            }
        override suspend fun iceServers(accountId: Long): kotlinx.serialization.json.JsonObject? = null
    }

    private class FakeMedia : CallMedia {
        var prepared: String? = null
        var applied: String? = null
        var micOn = true
        var closed = false
        override suspend fun prepare(hasVideo: Boolean, remoteSdp: String?): String {
            prepared = remoteSdp
            return if (remoteSdp == null) "offer-sdp" else "answer-sdp"
        }
        override suspend fun applyRemote(sdp: String) { applied = sdp }
        override fun setMic(enabled: Boolean) { micOn = enabled }
        override fun close() { closed = true }
    }

    private class Harness {
        val core = FakeCallCore()
        val media = FakeMedia()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val mgr = CallManager(
            coreProvider = { core },
            accountId = { 1L },
            mediaProvider = { media },
            scope = scope,
            getChatName = { "Alice" },
        ).apply { endedVisibleMs = 5 }

        suspend fun onEvent(chatId: Long, msgId: Long, event: CallEvent) = mgr.onCoreEvent(chatId, msgId, event)
        fun after(ms: Long = 20) = Thread.sleep(ms)
        fun close() = scope.cancel()
    }

    @Test
    fun `outgoing call - offer placed through the core, answer connects, end hangs up`() = runBlocking {
        val h = Harness()
        val started = h.mgr.startOutgoing(7L)
        assertTrue(started)
        assertIs<CallState.Outgoing>(h.mgr.state)
        assertEquals(listOf(7L to "offer-sdp"), h.core.placed)

        h.onEvent(7L, 4321L, CallEvent.OutgoingCallAccepted(7L, 4321L, "answer-sdp"))
        assertIs<CallState.Active>(h.mgr.state)
        assertEquals("answer-sdp", h.media.applied)

        h.onEvent(7L, 4321L, CallEvent.CallEnded(7L, 4321L))
        assertIs<CallState.Ended>(h.mgr.state)
        h.after(20)
        assertEquals(CallState.Idle, h.mgr.state)
        h.close()
    }

    @Test
    fun `incoming call - accept fetches the fresh offer, sends the sdp answer`() = runBlocking {
        val h = Harness()
        h.onEvent(3L, 55L, CallEvent.IncomingCall(3L, 55L, "remote-offer-sdp", hasVideo = false))
        assertIs<CallState.Incoming>(h.mgr.state)
        assertEquals("Alice", h.mgr.chatName)

        h.mgr.acceptIncoming()
        assertIs<CallState.Active>(h.mgr.state)
        // The accept used the fresh callInfo copy, not the event's payload.
        assertEquals(55L to "answer-sdp", h.core.accepted.single())
        assertEquals("remote-offer-sdp", h.media.prepared)

        h.onEvent(3L, 55L, CallEvent.CallEnded(3L, 55L))
        assertIs<CallState.Ended>(h.mgr.state)
        h.close()
    }

    @Test
    fun `decline ends the call through the core without an answer`() = runBlocking {
        val h = Harness()
        h.onEvent(3L, 56L, CallEvent.IncomingCall(3L, 56L, "x", hasVideo = false))
        h.mgr.declineIncoming()
        assertEquals(listOf(56L), h.core.ended)
        assertEquals(CallState.Idle, h.mgr.state)
        h.close()
    }

    @Test
    fun `acceptance on another device stands an incoming ring down`() = runBlocking {
        val h = Harness()
        h.onEvent(3L, 57L, CallEvent.IncomingCall(3L, 57L, "x", hasVideo = false))
        h.onEvent(3L, 57L, CallEvent.IncomingCallAccepted(3L, 57L))
        assertEquals(CallState.Idle, h.mgr.state)
        assertEquals(emptyList(), h.core.ended, "the call continues elsewhere — no hangup")
        h.close()
    }

    @Test
    fun `mute toggles the local track`() = runBlocking {
        val h = Harness()
        h.mgr.startOutgoing(7L)
        assertEquals(true, h.mgr.toggleMute())
        assertEquals(false, h.media.micOn)
        assertEquals(false, h.mgr.toggleMute())
        assertEquals(true, h.media.micOn)
        h.close()
    }

    @Test
    fun `a call-ended for another msgId does not touch the active call`() = runBlocking {
        val h = Harness()
        h.mgr.startOutgoing(7L)
        h.onEvent(7L, 4321L, CallEvent.OutgoingCallAccepted(7L, 4321L, "answer-sdp"))
        h.onEvent(7L, 999L, CallEvent.CallEnded(7L, 999L))
        assertIs<CallState.Active>(h.mgr.state)
        h.close()
    }

    @Test
    fun `no media adapter - outgoing placement refused, incoming still tracked`() = runBlocking {
        val h = Harness()
        val plain = CallManager({ h.core }, { 1L }, { null }, h.scope, { "Alice" })
        assertEquals(false, plain.startOutgoing(7L), "P1a has no WebRTC adapter yet — never send a fake offer")
        assertEquals(CallState.Idle, plain.state)
        plain.onCoreEvent(3L, 55L, CallEvent.IncomingCall(3L, 55L, "x", hasVideo = false))
        assertIs<CallState.Incoming>(plain.state)
        plain.declineIncoming()
        assertEquals(listOf(55L), h.core.ended)
        h.close()
    }

    @Test
    fun `hangup ends a live call through the core`() = runBlocking {
        val h = Harness()
        h.mgr.startOutgoing(7L)
        h.mgr.hangup()
        assertEquals(listOf(4321L), h.core.ended)
        assertIs<CallState.Ended>(h.mgr.state)
        assertTrue(h.media.closed)
        h.close()
    }
}
