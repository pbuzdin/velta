# Calls (audio + video, WebRTC in the WebView) — agent notes

Code: `app/js/calls.js` (CallManager: signaling state machine + media),
`velta-app/src-tauri/gen/android/app/src/main/java/org/velta/CallAudio.kt`
(Android audio route), `call_audio_*` commands in `velta-app/src-tauri/src/lib.rs`.
Tests: `tests/call-state-machine.test.mjs`, `tests/call-audio-route.test.mjs`,
`scripts/e2e-call-audio.mjs` (two Velta pages over real WebRTC in headless
Chromium with a fake mic + camera: audio both ways, video frames both ways,
camera off/on mid-call hides/shows the remote video via mutedState, buttons
at 320px; `--shots DIR` writes the call screens).

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

## Video calls and Delta Chat interop (2026-10-20, #141 follow-up)

Studied: core 2.63 `src/calls.rs` + jsonrpc `place_outgoing_call(chat,
sdp, has_video)`, `call_info` → `{sdpOffer, hasVideo, state}`, and
deltachat/calls-webapp (`src/lib/calls.ts`, `src/App.tsx`), the webapp DC
Android/Desktop/iOS embed. Findings:

- `has_video` is only a header (`Param::WebrtcHasVideoInitially`): it
  labels the call ("video call") and the incoming event; the media itself
  is whatever the SDP carries.
- The core carries ONE offer and ONE answer — no renegotiation. So DC adds
  BOTH transceivers (video + audio, sendrecv) to every offer, audio calls
  too (calls-webapp#90), and toggles the camera without renegotiation.
  Velta does the same: caller `addTransceiver(mic)` +
  `addTransceiver(camTrack || "video")`, both sendrecv with our stream id;
  callee reuses the offer's transceivers (`addTrack(mic)` for audio, which
  sets the stream id DC's `ontrack` reads as `e.streams[0]`; video:
  direction sendrecv, `replaceTrack`, `setStreams`).
- Camera on/off mid-call = `videoTx.sender.replaceTrack(track | null)`.
  Velta releases the camera while off (DC keeps it open with
  `track.enabled=false`, which sends black frames).
- Two negotiated data channels, created before offer/answer on both sides:
  id 1 `iceTrickling` (JSON `RTCIceCandidateInit`, or `null` = end) and id 3
  `mutedState` (`{"audioEnabled":bool,"videoEnabled":bool}`). DC shows the
  remote video only while the track is unmuted AND the last mutedState said
  videoEnabled; Velta mirrors that rule (`updateRemoteVideo`) and sends its
  own state on open, mute, and camera changes. Without mutedState DC would
  show our black/frozen frames. Velta still gathers ICE before sending its
  SDP (3 s cap) and trickles only later candidates; it applies DC's
  trickled candidates.
- `bundlePolicy: "max-bundle"` like DC.
- An offer without a video m-line (port 0 or absent — an old Velta build
  before this change, or a client with video disabled) means no camera in
  that call: the Camera button is hidden.

Entry points: chat header video icon (≥ 480px; at 320px the chat name had
0px left, so phones use ⋮ → **Video call**), both via
`startCallIfMicOk(chat, { video: true })`. A blocked camera does not stop a
video call: it continues audio-only with a toast. Incoming video calls show
Decline / Accept (audio only) / Accept with video.

Routing: `defaultSpeakerOn(hasVideo)` — video starts on the loudspeaker,
audio on the earpiece. Camera on mid-call → loudspeaker, off → earpiece;
both are `auto` switches (a connected headset keeps the audio). Only a tap
on Speaker forces the loudspeaker over a headset.

Flip camera: shown while video is on and `enumerateDevices` lists > 1
`videoinput`. Stops the old track first (phones cannot open two cameras),
then `facingMode: {ideal: next}`, falling back to the next deviceId
(desktop webcams); if no camera opens, video turns off and the peer is told.

## Call screen (Delta Chat style)

Built once per call (`ensureOverlay`, so the `<video>` elements keep
playing); `render()` updates name, status, avatar, video visibility and
the button row. Black background; top left the name in bold with the status
under it (Calling… / Ringing… / Connecting… / Reconnecting… on ICE
`disconnected` / the duration); a centered round avatar — the contact's
photo (`callPeerInfo` in app.js: chat/contact `profileImage` via
`fileUrl`) over its initial on the contact's core color (`avatarColor`, the
color Velta uses for that contact elsewhere); remote video full screen
replaces the avatar; the local preview is a draggable PiP (pointer events,
mirrored for the front camera). Bottom row of round buttons, End call in the
middle of the full row: Mute, Camera, End call (red, handset-down icon),
Speaker (Android), Switch camera. Fixed `aria-label`s; toggles carry
`aria-pressed` (Mute pressed = muted with a slashed mic, Camera pressed =
on, Speaker pressed = loudspeaker). 56px buttons, 50px below 360px: five fit
320px (checked by `scripts/e2e-call-audio.mjs`). The overlay is
`role="dialog" aria-modal`.

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
- `auto` flag (`call_audio_start/speaker(…, auto)`, Kotlin `autoRoute`):
  automatic switches (call start, camera on/off, headset plug) let a
  connected headset win over the loudspeaker; a Speaker tap is not auto.

## Buttons

`callButtonsHtml()` (pure, node-tested) renders every button; icons are
`CALL_ICONS` (24-unit viewBox, currentColor, header-icon style). Speaker
only when the route adapter is supported (Tauri + Android). Re-render keeps
keyboard focus on the same button.

## Debugging on a device

Build with `debug=true` (VELTA_DEBUG) or set `localStorage["velta-debug"]="1"`.
Every step logs a `[call] …` line (`callDebugLog`, a no-op without
VELTA_DEBUG) into the **Diagnostics chat** and, through the sink's `js_log`,
into `velta.log`:

- `mic: 1 track(s) [label enabled=true muted=false state=live]`,
  `camera: [label facing=user state=live]`
- `tracks: mic=true camera=… videoTx=true, N sender(s) with a track`
- `remote mutedState audio=… video=…`, `remote video shown|hidden`,
  `video=true|false`, `flip -> environment ok=true`
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

## PWA (wasm core in the browser)

- Same code path: `WorkerWasmTransport` → `worker-wasm.js` → wasm core →
  `JsonRpcCore` → `calls.js`. The wrapper forwards the full `CommandApi`, so
  `place_outgoing_call`, `accept_incoming_call`, `call_info`, `end_call` and
  `ice_servers` all dispatch in wasm (probed 2026-10-20 on the v1.4.75 wasm).
- `ice_servers` resolves TURN hostnames inside the core; on wasm that DNS
  goes through the C3 tunnel (`/dns/<host>`). With no tunnel, or a failed
  lookup, the core returns `[]`. `safeIceServers()` then uses
  `FALLBACK_ICE_SERVERS` (turn.delta.chat by hostname, same public
  credentials as the core's fallback): the browser resolves the name itself.
- Speaker button: hidden (`shellAudioRoute().supported` is false outside the
  Android shell); the browser/OS picks the output.
- getUserMedia prompts are the browser's own; the page is HTTPS, so it is
  allowed. A denied mic is caught by `startCallIfMicOk`.
- Limits: incoming calls ring only while a tab runs the core (no push, no
  service-worker IMAP); one tab holds the `velta-wasm-core` lock; no
  proximity sensor or earpiece routing; mobile browsers may pause a
  background tab and drop the call.
- `scripts/e2e-call-wasm.mjs`: two contexts running the PWA backend, with
  signaling over real IMAP/SMTP. Needs `WASM_DIST` plus `WS_TCP_PROXY`
  (raw TCP 993/465 out) or `RELAY_WS_URL` (a C3 relay that tunnels to the
  account's mail host). The agent box blocks raw TCP and a7's tunnel didn't
  resolve nine.testrun.org, so it has not passed end to end yet.
