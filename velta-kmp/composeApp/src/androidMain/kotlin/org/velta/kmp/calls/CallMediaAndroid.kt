package org.velta.kmp.calls

import android.content.Context
import kotlinx.serialization.json.JsonObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpSemantics
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.velta.kmp.ui.CallMedia

/**
 * WebRTC media adapter for 1:1 calls (P1b). Audio only in P1; the video
 * transceiver is still negotiated sendrecv in every offer/answer so the
 * camera can ride in later (P2) without renegotiation — the core carries
 * exactly ONE offer and ONE answer (calls.md "Video calls and DC interop").
 *
 * Ports the wiring rules `app/js/calls.js` encodes:
 * - caller: transceivers BEFORE createOffer; callee: setRemote first, the
 *   mic track reuses the offer's audio transceiver;
 * - non-trickle ICE: gather until complete or 3 s (GATHER_TIMEOUT), the
 *   offer/answer carries every candidate;
 * - two negotiated data channels created on the caller before the offer
 *   (id 1 "iceTrickling", id 3 "mutedState"; the callee receives them);
 * - mic mute = track.setEnabled, never removing the sender (#141).
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
                .setUsername("public").setPassword("o4tR7yG4rG2slhXqRUf9zgmHz").createIceServer(),
        )

        @Volatile private var factory: PeerConnectionFactory? = null

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
                            org.webrtc.audio.JavaAudioDeviceModule.builder(context.applicationContext).createAudioDeviceModule(),
                        )
                        .createPeerConnectionFactory()
                        .also { factory = it }
                }
            }
    }

    private var pc: PeerConnection? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var videoSource: VideoSource? = null
    private var surfaceHelper: SurfaceTextureHelper? = null
    private var videoCapturer: Camera2Enumerator? = null
    private var dcIce: DataChannel? = null
    private var dcMuted: DataChannel? = null

    private fun iceServersFromCore(): List<PeerConnection.IceServer> {
        val raw = try { iceServers() } catch (_: Throwable) { null } ?: return FALLBACK
        // ice_servers returns a JSON string: [{"urls":[...], "username":?, "credential":?}]
        val servers = mutableListOf<PeerConnection.IceServer>()
        try {
            val arr = kotlinx.serialization.json.Json.parseToJsonElement(raw.toString())
            val list = (arr as? kotlinx.serialization.json.JsonArray) ?: return FALLBACK
            for (server in list) {
                val o = server as? JsonObject ?: continue
                fun str(k: String): String? = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.content
                val urls = (o["urls"] as? kotlinx.serialization.json.JsonArray)
                    ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
                    ?: listOfNotNull(str("url"))
                if (urls.isEmpty()) continue
                val b = PeerConnection.IceServer.builder(urls)
                str("username")?.let { b.setUsername(it) }
                str("credential")?.let { b.setPassword(it) }
                servers.add(b.createIceServer())
            }
        } catch (_: Throwable) { /* parse failure = fallback below */ }
        return servers.ifEmpty { FALLBACK }
    }

    private fun newPeer(): PeerConnection {
        val rtcConfig = PeerConnection.RTCConfiguration(iceServersFromCore()).apply {
            sdpSemantics = SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
        }
        return PeerConnectionFactory.factory(context).createPeerConnection(rtcConfig, null)
            ?: error("no PeerConnection")
    }

    private fun micTrack(pcFactory: PeerConnectionFactory): AudioTrack {
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("EchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("EchoCancellation2", "true"))
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
        ) delay(50)
    }

    private fun wireChannels(caller: Boolean, pc: PeerConnection) {
        if (caller) {
            val init = DataChannel.Init().apply { this.id = 1; ordered = true }
            dcIce = pc.createDataChannel("iceTrickling", init)
            val init3 = DataChannel.Init().apply { this.id = 3; ordered = true }
            dcMuted = pc.createDataChannel("mutedState", init3)
        } else {
            pc.addObserver(object : PeerConnection.Observer {
                override fun onDataChannel(dc: DataChannel) {
                    when (dc.label()) {
                        "iceTrickling" -> dcIce = dc
                        "mutedState" -> dcMuted = dc
                    }
                }
                // Everything else ignored: the adapter only owns media.
                override fun onIceCandidate(candidate: IceCandidate) {}
                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
                override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {}
                override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
                override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
                override fun onRenegotiationNeeded() {}
                override fun onAddStream(stream: org.webrtc.MediaStream?) {}
                override fun onRemoveStream(stream: org.webrtc.MediaStream?) {}
                override fun onTrack(transceiver: org.webrtc.RtpTransceiver?, streams: MutableList<org.webrtc.MediaStream>?) {}
                override fun onStandardizedIceConnectionChange(newState: PeerConnection.IceConnectionState?) {}
            })
        }
    }

    private fun sendMutedState(audioEnabled: Boolean) {
        val dc = dcMuted ?: return
        val state = dc.state()
        if (state != DataChannel.State.OPEN) return
        val json = """{"audioEnabled":$audioEnabled,"videoEnabled":false}"""
        dc.send(DataChannel.Buffer(java.nio.ByteBuffer.wrap(json.toByteArray()), binary = false))
    }

    override suspend fun prepare(hasVideo: Boolean, remoteSdp: String?): String {
        // P1b is audio-only: the video transceiver is still offered sendrecv
        // (DC interop), the camera itself starts in P2.
        if (!micPermission()) throw IllegalStateException("no microphone permission")
        val pcFactory = PeerConnectionFactory.factory(context)
        val pc = newPeer()
        this.pc = pc
        val caller = remoteSdp == null
        wireChannels(caller, pc)
        val mic = micTrack(pcFactory)
        if (caller) {
            // Caller: both transceivers sendrecv BEFORE createOffer.
            pc.addTransceiver(mic, org.webrtc.RtpTransceiver.RtpTransceiverInit(
                org.webrtc.RtpTransceiver.RtpTransceiverDirection.SEND_RECV,
                listOf(STREAM_ID),
            ))
            pc.addTransceiver(
                MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,
                org.webrtc.RtpTransceiver.RtpTransceiverInit(org.webrtc.RtpTransceiver.RtpTransceiverDirection.SEND_RECV),
            )
            val offer = awaitSdp { pc.createOffer(it, MediaConstraints()) }
            pc.setLocalDescription(OfferSdpSink(offer), offer)
            waitGathered(pc)
            return pc.localDescription?.description ?: offer.description
        } else {
            // Callee: remote first; the mic track reuses the offer's audio
            // transceiver (calls-webapp #90 pattern), video goes sendrecv.
            val remoteDesc = org.webrtc.SessionDescription(
                org.webrtc.SessionDescription.OfferType.OFFER,
                requireNotNull(remoteSdp),
            )
            awaitSdp { pc.setRemoteDescription(it, remoteDesc) }
            pc.addTrack(mic, listOf(STREAM_ID))
            for (tx in pc.transceivers) {
                if (tx.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO) {
                    tx.direction = org.webrtc.RtpTransceiver.RtpTransceiverDirection.SEND_RECV
                }
            }
            val answer = awaitSdp { pc.createAnswer(it, MediaConstraints()) }
            pc.setLocalDescription(OfferSdpSink(answer), answer)
            waitGathered(pc)
            return pc.localDescription?.description ?: answer.description
        }
    }

    override suspend fun applyRemote(sdp: String) {
        val pc = pc ?: return
        val desc = org.webrtc.SessionDescription(org.webrtc.SessionDescription.AnswerType.ANSWER, sdp)
        awaitSdp { pc.setRemoteDescription(it, desc) }
    }

    override fun setMic(enabled: Boolean) {
        audioTrack?.setEnabled(enabled)
        sendMutedState(audioEnabled = enabled)
    }

    override fun close() {
        try { pc?.close() } catch (_: Throwable) {}
        try { audioSource?.dispose() } catch (_: Throwable) {}
        try { videoSource?.dispose() } catch (_: Throwable) {}
        try { surfaceHelper?.dispose() } catch (_: Throwable) {}
        audioSource = null; audioTrack = null; videoSource = null
        surfaceHelper = null; videoCapturer = null; dcIce = null; dcMuted = null
        pc = null
    }

    private fun awaitSdp(block: (org.webrtc.SdpObserver) -> Unit): org.webrtc.SessionDescription {
        val latch = java.util.concurrent.CountDownLatch(1)
        var out: org.webrtc.SessionDescription? = null
        var failure: String? = null
        block(object : org.webrtc.SdpObserver {
            override fun onCreateSuccess(desc: org.webrtc.SessionDescription) { out = desc; latch.countDown() }
            override fun onSetSuccess() { latch.countDown() }
            override fun onCreateFailure(error: String?) { failure = error; latch.countDown() }
            override fun onSetFailure(error: String?) { failure = error; latch.countDown() }
        })
        check(latch.await(5, java.util.concurrent.TimeUnit.SECONDS)) { "SDP operation timed out" }
        failure?.let { throw IllegalStateException(it) }
        return out ?: error("no SDP produced")
    }

    private suspend fun delay(ms: Long) = kotlinx.coroutines.delay(ms)

    private class OfferSdpSink(val sdp: org.webrtc.SessionDescription) : org.webrtc.SdpObserver {
        override fun onCreateSuccess(desc: org.webrtc.SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) {}
        override fun onSetFailure(error: String?) {}
    }
}
