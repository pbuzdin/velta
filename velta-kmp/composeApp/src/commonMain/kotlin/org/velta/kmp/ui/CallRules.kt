package org.velta.kmp.ui

/**
 * Call signaling state machine (P1, 1:1 calls) — the KMP port of the web
 * CallManager's rules (`app/js/calls.js`, spec-tested by
 * `tests/call-state-machine.test.mjs`). The core carries the signaling
 * (`place_outgoing_call` / `accept_incoming_call` / `end_call`, non-trickle
 * ICE); these rules only decide state transitions and guards. Media is an
 * injected adapter (WebRTC, androidMain in P1b) so desktopTest can run the
 * whole flow with fakes.
 */
sealed interface CallState {
    data object Idle : CallState
    /** Offer in flight: media prepared, `place_outgoing_call` not answered yet. */
    data class Connecting(val chatId: Long) : CallState
    /** Our offer placed (msgId = the call message); ringing on both sides. */
    data class Outgoing(val chatId: Long, val msgId: Long, val hasVideo: Boolean) : CallState
    /** Incoming ring; placeCallInfo is the caller's SDP offer. */
    data class Incoming(val chatId: Long, val msgId: Long, val hasVideo: Boolean, val placeCallInfo: String) : CallState
    /** Answer applied / offer answered; RTP flows. */
    data class Active(val chatId: Long, val msgId: Long) : CallState
    /** Terminal frame between a live state and Idle (UI shows "call ended"). */
    data class Ended(val chatId: Long, val msgId: Long) : CallState
}

/** Events the core fires (Payload names camelCased, snake fallbacks kept
 *  where the web keeps them). */
sealed interface CallEvent {
    data class IncomingCall(val chatId: Long, val msgId: Long, val placeCallInfo: String, val hasVideo: Boolean) : CallEvent
    data class OutgoingCallAccepted(val chatId: Long, val msgId: Long, val acceptCallInfo: String) : CallEvent
    /** Another device of this account accepted — stand the ring down. */
    data class IncomingCallAccepted(val chatId: Long, val msgId: Long) : CallEvent
    data class CallEnded(val chatId: Long, val msgId: Long) : CallEvent
    /** `place_outgoing_call` returned the call message's id. */
    data class OfferPlaced(val chatId: Long, val msgId: Long) : CallEvent
    data object Declined : CallEvent
    data object AcceptedActive : CallEvent
    data object EndedTick : CallEvent
}

object CallRules {

    fun idle(): CallState = CallState.Idle

    fun incomingCall(state: CallState, chatId: Long, msgId: Long, placeCallInfo: String, hasVideo: Boolean): CallState =
        if (state is CallState.Idle) CallState.Incoming(chatId, msgId, hasVideo, placeCallInfo) else state

    fun offerPlaced(state: CallState, chatId: Long, msgId: Long): CallState =
        if (state is CallState.Connecting && state.chatId == chatId) CallState.Outgoing(chatId, msgId, hasVideo = false)
        else state

    fun outgoingAccepted(state: CallState, chatId: Long, msgId: Long): CallState =
        if (state is CallState.Outgoing && state.msgId == msgId && state.chatId == chatId)
            CallState.Active(chatId, msgId)
        else state

    /** Another device took it: stand down, no endCall (the call continues). */
    fun incomingAcceptedElsewhere(state: CallState, chatId: Long, msgId: Long): CallState =
        if (state is CallState.Incoming && state.msgId == msgId && state.chatId == chatId) CallState.Idle else state

    /** A matching end lands in Ended (UI frame, then tick to Idle); a call
     *  ended for another msgId never touches a live call. */
    fun callEnded(state: CallState, chatId: Long, msgId: Long): CallState =
        when (state) {
            is CallState.Outgoing -> if (state.msgId == msgId && state.chatId == chatId) CallState.Ended(state.chatId, msgId) else state
            is CallState.Incoming -> if (state.msgId == msgId && state.chatId == chatId) CallState.Ended(state.chatId, msgId) else state
            is CallState.Active -> if (state.msgId == msgId && state.chatId == chatId) CallState.Ended(state.chatId, msgId) else state
            else -> state
        }

    fun declined(state: CallState, chatId: Long, msgId: Long): CallState =
        if (state is CallState.Incoming && state.msgId == msgId && state.chatId == chatId) CallState.Idle else state

    fun accepted(state: CallState, chatId: Long, msgId: Long): CallState =
        if (state is CallState.Incoming && state.msgId == msgId && state.chatId == chatId) CallState.Active(chatId, msgId) else state

    fun endedTick(state: CallState): CallState =
        if (state is CallState.Ended) CallState.Idle else state

    /** The msgId a live call would hang up with (null: nothing to end). */
    fun activeMsgId(state: CallState): Long? = when (state) {
        is CallState.Outgoing -> state.msgId
        is CallState.Incoming -> state.msgId
        is CallState.Active -> state.msgId
        else -> null
    }
}
