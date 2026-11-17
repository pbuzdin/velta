package org.velta.kmp.core

import kotlinx.serialization.json.JsonObject

/**
 * Core call signaling (deltachat `src/calls.rs` via jsonrpc) — the boundary
 * CallManager drives; the media side is [org.velta.kmp.ui.CallMedia] (WebRTC,
 * androidMain in P1b).
 */
interface CallCore {
    /** `place_outgoing_call` -> the call message's id (used to match events). */
    suspend fun placeOutgoingCall(accountId: Long, chatId: Long, offerSdp: String, hasVideo: Boolean): Long

    suspend fun acceptIncomingCall(accountId: Long, msgId: Long, answerSdp: String)

    suspend fun endCall(accountId: Long, msgId: Long)

    /** `call_info` -> `{sdpOffer, hasVideo, state}` — a fresh copy of the
     *  caller's offer, valid even if the IncomingCall event was missed. */
    suspend fun callInfo(accountId: Long, msgId: Long): JsonObject?

    /** Configured ICE servers (raw core list; empty = media-side fallbacks). */
    suspend fun iceServers(accountId: Long): JsonObject?
}
