# Calls (audio, WebRTC in the WebView) — agent notes

Code: `app/js/calls.js` (CallManager: signaling state machine + media),
`velta-app/src-tauri/gen/android/app/src/main/java/org/velta/CallAudio.kt`
(Android audio route), `call_audio_*` commands in `velta-app/src-tauri/src/lib.rs`.
Tests: `tests/call-state-machine.test.mjs`, `tests/call-audio-route.test.mjs`,
`scripts/e2e-call-audio.mjs` (real WebRTC in headless Chromium).

## Media flow (#141 root cause)

The core carries the signaling (offer SDP in `place_outgoing_call`, answer in
`accept_incoming_call`, non-trickle ICE). The page owns the media:

1. `getUserMedia(MIC_CONSTRAINTS)` — audio with echo cancellation, noise
   suppression, AGC; video false. A stream without an audio track fails the
   call ("no microphone track") instead of placing a silent one.
2. `addLocalTracks()` — `pc.addTrack(micTrack, stream)`.
   - Caller: BEFORE `createOffer`.
   - Callee: AFTER `setRemoteDescription(offer)` (reuses the offer's audio
     transceiver, like deltachat/calls-webapp) and BEFORE `createAnswer`.
3. Remote audio plays in a hidden `<audio id="call-remote-audio">`; the
   `track` handler falls back to `e.track` when the peer sent no stream id.

**KEEP:** until #141, step 2 did not exist. The mic was opened (Android
showed the mic indicator, the permission was granted) but no sender existed,
so the offer was `recvonly` (answer `inactive` between two Veltas) and not a
single RTP packet left the device — "the microphone doesn't work" on every
platform. `scripts/e2e-call-audio.mjs` shows it: old code sent 0 packets,
offer recvonly; fixed code sends both ways, both SDPs sendrecv. Mute only
flips `track.enabled`; never `replaceTrack(null)` or remove the sender.

## Android audio route (earpiece default, speaker toggle)

- `CallManager` gets an injected route adapter; the default
  `shellAudioRoute()` is supported only in the Tauri shell on Android
  (`isTauri() && isAndroid()`). Desktop and the PWA report unsupported and
  the Speaker button is hidden there (a desktop has no earpiece; `setSinkId`
  output pickers are a separate feature, not this toggle).
- `startRoute()` runs right AFTER getUserMedia: Chromium's WebView switches
  the audio mode itself when capture starts (AudioManagerAndroid, which picks
  the loudspeaker — the "speaker by default" half of #141), so Velta's call
  must come later to win. The route is re-asserted on
  `connectionState === "connected"`.
- `CallAudio.start(ctx, speaker)`: voice-communication audio focus,
  `MODE_IN_COMMUNICATION`, then the route. Speaker off = a connected wired /
  USB / Bluetooth headset if any, else the earpiece. API 31+:
  `setCommunicationDevice` (TYPE_BUILTIN_EARPIECE / TYPE_BUILTIN_SPEAKER /
  headset types); API 24-30: `setSpeakerphoneOn`, plus `startBluetoothSco`
  for a BT headset (needs the `BLUETOOTH` permission, maxSdkVersion 30).
  An `AudioDeviceCallback` re-applies the choice on plug / unplug.
- Earpiece route holds a `PROXIMITY_SCREEN_OFF_WAKE_LOCK` (screen off at the
  ear); released on speaker/headset and on stop
  (`RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY`).
- `CallAudio.stop`: clear the device, speakerphone off, SCO off,
  **MODE_NORMAL** (not "the saved mode" — the WebView had already switched
  to IN_COMMUNICATION before start ran), focus abandoned. The page calls it
  after stopping the tracks (`releaseMedia`), and `MainActivity.onDestroy`
  calls it as a safety net.
- Shell calls are serialized (`queueRoute`) so a stop never overtakes a start.
- Video calls: `defaultSpeakerOn(hasVideo)` returns true for video (phone not
  at the ear — the usual convention). Velta answers and places audio-only
  calls today, so every call starts on the earpiece.

## Speaker button

`callButtonsHtml()` (pure, node-tested): `<button type="button"
data-call="speaker" class="call-btn call-speaker" aria-pressed="…">` with an
inline speaker SVG (`aria-hidden`) and a FIXED label "Speaker" — the state
is `aria-pressed` (pressed = loudspeaker), never a changing label. Shown
while ringing and connected, only when the route adapter is supported.
Re-render keeps keyboard focus on the same button. `.call-actions` wraps
and tightens below 360px so Mute / Speaker / End call fit a 320px phone.

## Debugging on a device

Build with `debug=true` (VELTA_DEBUG) or set `localStorage["velta-debug"]="1"`.
Every step logs a `[call] …` line (`callDebugLog`, a no-op without
VELTA_DEBUG) into the **Diagnostics chat** and, through the sink's `js_log`,
into `velta.log`:

- `mic: 1 track(s) [label enabled=true muted=false state=live]`
- `addTrack: 1 audio track(s), 1 sender(s) with a track`
- `offer audio=sendrecv` / `remote offer audio=…` / `answer audio=sendrecv`
  / `remote answer audio=…` (a `recvonly` here = the peer will not hear us)
- `connection=…`, `ice=…`, `remote track kind=audio …`
- `audio route start speaker=false route=earpiece`, `speaker=true route=speaker`
  (Rust also logs `[call] audio start/speaker/stop -> Ok("…")`)

Where to read them (CI APKs are release builds, so `run-as` does not work):

- The Diagnostics chat (drawer → Diagnostics): `[INFO] [call] …` rows,
  no adb needed. The WebView console does NOT reach logcat on these builds
  (Tauri's Logger is gated on BuildConfig.DEBUG).
- `adb logcat -s VeltaCallAudio` — the native route (android.util.Log, not
  gated): mode, chosen device, `setCommunicationDevice` refusals, headset
  plug/unplug, stop.
- velta.log (Rust `log()` lines incl. `[call] audio start … -> Ok("earpiece")`):
  turn on Diagnostics → **Logging** first (default off, V-09/#66); it is
  mirrored to `/storage/emulated/0/Android/data/<id>/files/logs/velta.log`.
- Diagnostics → DevTools + `chrome://inspect`: `pc.getStats()` —
  outbound-rtp audio `packetsSent` must grow during the call.
