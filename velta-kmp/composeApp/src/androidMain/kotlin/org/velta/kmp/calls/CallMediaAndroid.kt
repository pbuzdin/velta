package org.velta.kmp.calls

import android.content.Context
import kotlinx.serialization.json.JsonObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

/**
 * WebRTC media adapter for 1:1 calls (P1b, audio only). Ports the wiring
 * rules `app/js/calls.js` encodes:
 * - caller: BOTH transceivers sendrecv BEFORE createOffer (the core carries
 *   exactly one offer and one answer, so video later rides the already
 *   negotiated transceivers — P2 needs no renegotiation);
 * - callee: setRemote first, the mic track reuses the offer's audio
 *   transceiver (calls-webapp #90), the video transceiver goes sendrecv;
 * - non-trickle ICE: gather until complete or 3 s — the offer/answer
 *   carries every candidate;
 * - two data channels negotiated on the caller (id 1 "iceTrickling", id 3
 *   "mutedState"), captured via the observer on the callee;
 * - mic mute = track.setEnabled + a mutedState frame — never removing the
 *   sender (#141).
 *
 * Uses the same prebuilt libwebrtc deltachat-android ships
 * (im.conversations.webrtc:webrtc-android, unified plan only in 129).
 */
class CallMediaAndroid(
    private val context: Context,
    /** Fresh ICE server config from the core (falls back to turn.delta.chat). */
    private val iceServers: suspend () -> JsonObject?,
    /** RECORD_AUDIO consent, asked on the first call (or reused from voice). */
    private val micPermission: suspend () -> Boolean,
) : CallMedia {

    companion object {
        private const val GATHER_TIMEOUT_MS = 3000L
        private const val STREAM_ID = "velta_local_stream"
        private const val AUDIO_TRACK_ID = "velta_audio_track"

        /** Same server and public credentials as core create_fallback_ice_servers(). */
        private val FALLBACK = listOf(
            PeerConnection.IceServer.builder("turn:turn.delta.chat:3478")
                .setUsername("public")
                .setPassword("o4tR7yG4rG2slhXqRUf9zgmHz")
                .createIceServer(),
        )

        @Volatile
        private var factory: PeerConnectionFactory? = null

        fun factory(context: Context): PeerConnectionFactory =
            factory ?: synchronized(this) {
                factory ?: run {
                    PeerConnectionFactory.initialize(
                        PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                            .setEnableInternalTracer(false)
                            .createInitializationOptions(),
                    )
                    PeerConnectionFactory.builder()
                        .setAudioDeviceModule(
                            org.webrtc.audio.JavaAudioDeviceModule.builder(context.applicationContext)
                                .createAudioDeviceModule(),
                        )
                        .createPeerConnectionFactory()
                        .also { factory = it }
                }
            }
    }

    private var pc: PeerConnection? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var dcIce: DataChannel? = null
    private var dcMuted: DataChannel? = null

    private suspend fun iceServersFromCore(): List<PeerConnection.IceServer> {
        val raw = try {
            iceServers()
        } catch (_: Throwable) {
            null
        } ?: return FALLBACK
        // ice_servers returns a JSON string: [{"urls":[...], "username":?, "credential":?}]
        val servers = mutableListOf<PeerConnection.IceServer>()
        try {
            val parsed = kotlinx.serialization.json.Json.parseToJsonElement(raw.toString())
            for (server in parsed as? kotlinx.serialization.json.JsonArray ?: emptyList()) {
                val o = server as? JsonObject ?: continue
                fun str(k: String): String? = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.content
                val urls = (o["urls"] as? kotlinx.serialization.json.JsonArray)
                    ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
                    ?: listOfNotNull(str("url"))
                if (urls.isEmpty()) continue
                val builder = PeerConnection.IceServer.builder(urls)
                str("username")?.let { builder.setUsername(it) }
                str("credential")?.let { builder.setPassword(it) }
                servers.add(builder.createIceServer())
            }
        } catch (_: Throwable) {
            /* parse failure = fallback below */
        }
        return servers.ifEmpty { FALLBACK }
    }

    private fun newPeer(caller: Boolean): PeerConnection {
        val rtcConfig = PeerConnection.RTCConfiguration(iceServersFromCore()).apply {
            // Unified plan is the only semantics in libwebrtc 129.
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
        }
        val observer = if (caller) null else object : PeerConnection.Observer {
            override fun onDataChannel(dc: DataChannel) {
                when (dc.label()) {
                    "iceTrickling" -> dcIce = dc
                    "mutedState" -> dcMuted = dc
                }
            }

            override fun onIceCandidate(candidate: IceCandidate) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {}
            override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
            override fun onStandardizedIceConnectionChange(newState: PeerConnection.IceConnectionState?) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddStream(stream: org.webrtc.MediaStream?) {}
            override fun onRemoveStream(stream: org.webrtc.MediaStream?) {}
            override fun onTrack(transceiver: RtpTransceiver?) {}
        }
        return factory(context).createPeerConnection(rtcConfig, observer) ?: error("no PeerConnection")
    }

    private fun micTrack(pcFactory: PeerConnectionFactory): AudioTrack {
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("EchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("NS", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("GainControl", "true"))
        }
        val source = pcFactory.createAudioSource(constraints)
        audioSource = source
        return pcFactory.createAudioTrack(AUDIO_TRACK_ID, source).also { audioTrack = it }
    }

    private suspend fun waitGathered(pc: PeerConnection) {
        val deadline = System.currentTimeMillis() + GATHER_TIMEOUT_MS
        while (pc.iceGatheringState() != PeerConnection.IceGatheringState.COMPLETE &&
            System.currentTimeMillis() < deadline
        ) {
            kotlinx.coroutines.delay(50)
        }
    }

    private fun wireCallerChannels(pc: PeerConnection) {
        dcIce = pc.createDataChannel("iceTrickling", DataChannel.Init().apply { id = 1; ordered = true })
        dcMuted = pc.createDataChannel("mutedState", DataChannel.Init().apply { id = 3; ordered = true })
    }

    private fun sendMutedState(audioEnabled: Boolean) {
        val dc = dcMuted ?: return
        if (dc.state() != DataChannel.State.OPEN) return
        val json = """{"audioEnabled":$audioEnabled,"videoEnabled":false}"""
        dc.send(DataChannel.Buffer(java.nio.ByteBuffer.wrap(json.toByteArray()), binary = false))
    }

    override suspend fun prepare(hasVideo: Boolean, remoteSdp: String?): String {
        // P1b is audio-only: the video transceiver is still offered sendrecv
        // (DC interop), the camera itself starts in P2.
        if (!micPermission()) throw IllegalStateException("no microphone permission")
        val pcFactory = factory(context)
        val caller = remoteSdp == null
        val pc = newPeer(caller)
        this.pc = pc
        val mic = micTrack(pcFactory)
        if (caller) {
            wireCallerChannels(pc)
            pc.addTransceiver(
                mic,
                RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV, listOf(STREAM_ID)),
            )
            pc.addTransceiver(
                MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,
                RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV),
            )
            val offer = awaitSdp { pc.createOffer(it, MediaConstraints()) }
            awaitSet { pc.setLocalDescription(it, offer) }
            waitGathered(pc)
            return pc.localDescription?.description ?: offer.description
        } else {
            val remoteDesc = SessionDescription(SessionDescription.OfferType.OFFER, requireNotNull(remoteSdp))
            awaitSet { pc.setRemoteDescription(it, remoteDesc) }
            pc.addTrack(mic, listOf(STREAM_ID))
            for (tx in pc.transceivers) {
                if (tx.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO) {
                    tx.direction = RtpTransceiver.RtpTransceiverDirection.SEND_RECV
                }
            }
            val answer = awaitSdp { pc.createAnswer(it, MediaConstraints()) }
            awaitSet { pc.setLocalDescription(it, answer) }
            waitGathered(pc)
            return pc.localDescription?.description ?: answer.description
        }
    }

    override suspend fun applyRemote(sdp: String) {
        val pc = pc ?: return
        val desc = SessionDescription(SessionDescription.AnswerType.ANSWER, sdp)
        awaitSet { pc.setRemoteDescription(it, desc) }
    }

    override fun setMic(enabled: Boolean) {
        audioTrack?.setEnabled(enabled)
        sendMutedState(audioEnabled = enabled)
    }

    override fun close() {
        try { pc?.close() } catch (_: Throwable) {}
        try { audioSource?.dispose() } catch (_: Throwable) {}
        audioSource = null
        audioTrack = null
        dcIce = null
        dcMuted = null
        pc = null
    }

    private fun awaitSet(block: (SdpObserver) -> Unit) {
        val latch = java.util.concurrent.CountDownLatch(1)
        var failure: String? = null
        block(object : SdpObserver {
            override fun onCreateSuccess(desc: SessionDescription?) {}
            override fun onSetSuccess() { latch.countDown() }
            override fun onCreateFailure(error: String?) { failure = error; latch.countDown() }
            override fun onSetFailure(error: String?) { failure = error; latch.countDown() }
        })
        check(latch.await(5, java.util.concurrent.TimeUnit.SECONDS)) { "SDP operation timed out" }
        failure?.let { throw IllegalStateException(it) }
    }

    private fun awaitSdp(block: (SdpObserver) -> Unit): SessionDescription {
        val latch = java.util.concurrent.CountDownLatch(1)
        var out: SessionDescription? = null
        var failure: String? = null
        block(object : SdpObserver {
            override fun onCreateSuccess(desc: SessionDescription) { out = desc; latch.countDown() }
            override fun onSetSuccess() { latch.countDown() }
            override fun onCreateFailure(error: String?) { failure = error; latch.countDown() }
            override fun onSetFailure(error: String?) { failure = error; latch.countDown() }
        })
        check(latch.await(5, java.util.concurrent.TimeUnit.SECONDS)) { "SDP operation timed out" }
        failure?.let { throw IllegalStateException(it) }
        return out ?: error("no SDP produced")
    }
}
