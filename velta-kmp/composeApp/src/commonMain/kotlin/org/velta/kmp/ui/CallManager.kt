package org.velta.kmp.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.velta.kmp.core.CallCore

/**
 * Media side of a call (WebRTC on Android, fake in tests). The adapter owns
 * the PeerConnection: it wires BOTH transceivers sendrecv before offer/answer
 * (calls.js #141 lesson), gathers ICE for at most [GATHER_TIMEOUT_MS] (the
 * core signaling is non-trickle), and opens the two data channels (id 1
 * iceTrickling, id 3 mutedState). `remoteSdp = null` means caller (produce
 * the offer); non-null means callee (apply the offer, produce the answer).
 */
interface CallMedia {
    suspend fun prepare(hasVideo: Boolean, remoteSdp: String?): String
    /** Caller side: the peer's answer arrived — apply it (the callee's
     *  answer already went out through prepare). */
    suspend fun applyRemote(sdp: String)
    fun setMic(enabled: Boolean)
    fun close()
}

/** The engine that turns the rules into signaling + media (P1a: protocol
 *  plumbing, androidMain supplies the WebRTC [CallMedia] in P1b). */
class CallManager(
    private val coreProvider: () -> CallCore?,
    private val accountId: () -> Long?,
    private val mediaProvider: () -> CallMedia?,
    private val scope: CoroutineScope,
    private val getChatName: suspend (Long) -> String?,
) {
    var state by mutableStateOf<CallState>(CallRules.idle())
        private set
    var chatName by mutableStateOf<String?>(null)
        private set
    var micEnabled by mutableStateOf(true)
        private set

    /** How long the Ended frame stays before Idle (web endedVisibleMs). */
    var endedVisibleMs: Long = 4000

    private var endedJob: Job? = null

    suspend fun startOutgoing(chatId: Long, hasVideo: Boolean = false): Boolean {
        val media = mediaProvider() ?: return false
        if (state !is CallState.Idle) return false
        state = CallState.Connecting(chatId)
        chatName = getChatName(chatId)
        val offer = try {
            media.prepare(hasVideo, remoteSdp = null)
        } catch (t: Throwable) {
            state = CallRules.idle()
            throw t
        }
        val core = coreProvider() ?: run { state = CallRules.idle(); return false }
        val acc = accountId() ?: run { state = CallRules.idle(); return false }
        val msgId = core.placeOutgoingCall(acc, chatId, offer, hasVideo)
        state = CallRules.offerPlaced(state, chatId, msgId)
        return true
    }

    suspend fun onCoreEvent(chatId: Long, msgId: Long, event: CallEvent) {
        when (event) {
            is CallEvent.IncomingCall -> {
                val next = CallRules.incomingCall(state, chatId, msgId, event.placeCallInfo, event.hasVideo)
                if (next != state) {
                    state = next
                    chatName = getChatName(chatId)
                }
            }
            is CallEvent.OfferPlaced -> state = CallRules.offerPlaced(state, chatId, msgId)
            is CallEvent.OutgoingCallAccepted -> {
                val next = CallRules.outgoingAccepted(state, chatId, msgId)
                if (next != state) {
                    state = next
                    mediaProvider()?.applyRemote(event.acceptCallInfo)
                }
            }
            is CallEvent.IncomingCallAccepted -> {
                val next = CallRules.incomingAcceptedElsewhere(state, chatId, msgId)
                if (next != state) {
                    state = next
                    mediaProvider()?.close()
                }
            }
            CallEvent.Declined -> {
                val s = state as? CallState.Incoming ?: return
                val next = CallRules.declined(state, s.chatId, s.msgId)
                if (next != state) {
                    state = next
                    mediaProvider()?.close()
                }
            }
            CallEvent.AcceptedActive -> {
                val s = state as? CallState.Incoming ?: return
                state = CallRules.accepted(state, s.chatId, s.msgId)
            }
            is CallEvent.CallEnded -> {
                val next = CallRules.callEnded(state, chatId, msgId)
                if (next != state) {
                    state = next
                    mediaProvider()?.close()
                    scheduleIdleTick()
                }
            }
            CallEvent.EndedTick -> state = CallRules.endedTick(state)
        }
    }

    suspend fun acceptIncoming() {
        val s = state as? CallState.Incoming ?: return
        val m = mediaProvider() ?: return
        val core = coreProvider() ?: return
        val acc = accountId() ?: return
        // Fresh offer copy from callInfo — valid even if the IncomingCall
        // event was missed while the app was closed (web callInfo contract).
        val offer = core.callInfo(acc, s.msgId)
            ?.get("sdpOffer")?.let { it as? kotlinx.serialization.json.JsonPrimitive }?.content
            ?: s.placeCallInfo
        val answer = m.prepare(s.hasVideo, remoteSdp = offer)
        core.acceptIncomingCall(acc, s.msgId, answer)
        onCoreEvent(s.chatId, s.msgId, CallEvent.AcceptedActive)
    }

    suspend fun declineIncoming() {
        val s = state as? CallState.Incoming ?: return
        val core = coreProvider() ?: return
        val acc = accountId() ?: return
        core.endCall(acc, s.msgId)
        onCoreEvent(s.chatId, s.msgId, CallEvent.Declined)
    }

    /** Hang up a live call (ringing our offer, ringing incoming, or active). */
    suspend fun hangup() {
        val msgId = CallRules.activeMsgId(state) ?: return
        val chatId = (state as? CallState.Outgoing)?.chatId
            ?: (state as? CallState.Incoming)?.chatId
            ?: (state as? CallState.Active)?.chatId
            ?: return
        val core = coreProvider() ?: return
        val acc = accountId() ?: return
        core.endCall(acc, msgId)
        onCoreEvent(chatId, msgId, CallEvent.CallEnded(chatId, msgId))
    }

    /** Mute flips the local track only — never replaceTrack(null) (calls.js
     *  #141: removing the sender kills the call's audio both ways). */
    fun toggleMute(): Boolean? {
        val m = mediaProvider() ?: return null
        micEnabled = !micEnabled
        m.setMic(micEnabled)
        return micEnabled
    }

    suspend fun teardown() {
        mediaProvider()?.close()
        state = CallRules.idle()
    }

    private fun scheduleIdleTick() {
        endedJob?.cancel()
        endedJob = scope.launch {
            delay(endedVisibleMs)
            onCoreEvent(0, 0, CallEvent.EndedTick)
        }
    }
}
