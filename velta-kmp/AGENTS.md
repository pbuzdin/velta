# Velta KMP client — agent notes

Native Android + Desktop client (Kotlin Multiplatform + Compose Multiplatform).
Tracking issue: **#192**. Phase status + honest gaps: **docs/PHASES.md**.
Read this file before touching anything in this folder.

**2026-11-13: the #321 visual shell is COMPLETE — all five steps shipped
and audited against the code** (theme tokens, web-parity icons, stable
composer/header, bubbles/quote/markdown/list rows, appearance settings +
en/ru/fr strings). KMP is the Android delivery track; the Tauri app
remains Velta's shipping Android client; the Rust UI preview is a
separate experiment (#314). Phase plan in #192: N1 design port
(Prism + identity matrix — shipped, see PrismIdentityTest), N2
conversation notifications + RPC timeout/respawn (shipped), N3 AGSL glass
on the composer and header (shipped), N4 release signing still open.
Fidelity follow-ups live in #323–#329.

## Layout

```
composeApp/src/
  commonMain/    Compose UI + AppModel + VeltaCore facade (PURE Kotlin — no java.*: compile fails even for JVM-only targets)
  jvmCommon/     shared JVM layer: process + socket transports, java.time formatters
  androidMain/   MainActivity (FragmentActivity: BiometricPrompt; NO registered-launcher
                 startActivityForResult — 16-bit crash, use startActivity + AppHolder),
                 AppHolder (process-wide model), VeltaForegroundService, push/VeltaPushService,
                 scan/ScanActivity (CameraX + ZXing), VeltaKeystore + VeltaLock (app lock,
                 dbkey.wrap + dbkey.bio), RpcShim (JNI), CorePlatform impl, MediaAndroid,
                 AndroidIncomingNotifier (conversation notifications)
  desktopMain/   DesktopCorePlatform (sidecar spawn), Main (window + FileDialog),
                 MediaDesktop, PlatformBack actual
  desktopTest/   all tests (scripted transports + real-binary IT)
  commonMain/composeResources/drawable/v_logo.png
                 header mark. PNG only — Android painterResource throws on SVG.
                 Delete a removed SVG in the WSL tree too; tar overlay keeps it.
  ui/Glass.kt + GlassAndroid.kt + GlassDesktop.kt
                 expect/actual lens. AGSL on API 33, blur on API 31, translucent
                 below that and on desktop. Do not give the actuals the same file name.
  ui/VeltaTokens.kt + ui/VeltaIcons.kt
                 GENERATED (tools/gen-kmp-theme.mjs from app/css/main.css;
                 tools/gen-kmp-icons.mjs evals the REAL app/js/icons.js) —
                 never hand-edit; staleness tests fail CI
                 (tests/kmp-theme-tokens.test.mjs, tests/kmp-icons.test.mjs).
  ui/LangRu.kt + ui/LangFr.kt
                 GENERATED string packs (tools/gen-kmp-strings.mjs from the
                 REAL app/locales/{ru,fr}.json), filtered to this client's
                 L.t("…") call sites; tests/kmp-strings.test.mjs fails CI on
                 staleness AND on any used key missing from a pack.
  ui/L10n.kt     L.t(): the English string IS the key (i18n.js rule) — a
                 missing pack value falls back to English. Only wrap strings
                 that exist as keys in BOTH web packs; everything else stays
                 an English literal (the sticker empty-state, #326).
  ui/Accent.kt   port of app/js/chat-appearance.js: WCAG 2.x derivation of a
                 custom accent (soft-ink HSL search, tintStable, alpha-
                 composited surfaces — bgReply/bgHover composite over their
                 real backdrops before contrast math).
  ui/BareLinks.kt + ui/Mentions.kt
                 1:1 ports of app/js/bare-links.js / mentions.js.
  ui/Markdown.kt markdown subset + parseInviteLink (canonical i.delta.chat
                 link; 40-hex on BOTH forms; safe percent-decode).
native/rpc-shim/ Rust cdylib: in-process core for Android (JSON Lines on 127.0.0.1);
                 size-tuned release profile (lto + codegen-units=1 + opt-level=s + strip)
composeApp/proguard-rules.pro — R8 keeps: RpcShim native methods, serialization, UnifiedPush
composeApp/keystore.properties — release signing (gitignored; absent → debug-key fallback)
```

Expect/actual lives in commonMain + one actual per target; anything JVM-only
that BOTH targets need goes in jvmCommon (wire it with `dependsOn(commonMain.get())`).
⚠️ expect/actual files must NOT share a FILE NAME across source sets — the
JVM facade classes collide (Media.kt → MediaAndroid.kt/MediaDesktop.kt).
⚠️ ANY source change (including renames) needs the tar-sync below; renames
also need explicit `rm` of the old file in the WSL copy (overlay keeps it).
⚠️ The tar-sync only OVERLAYS: files deleted on the Windows side linger in
~/velta-kmp-build forever (a stale Chrome.kt from Nov 2 survived until it
broke the build with duplicate declarations). `rm` such files explicitly.
⚠️ Every Kotlin file MUST carry its `package` line — a package-less file
lands in the default package and its symbols are unresolvable from
org.velta.kmp.*; the errors appear in the CONSUMING files, not the culprit.
⚠️ FragmentActivity traps: (1) registered ActivityResult launchers crash
with "lower 16 bits for requestCode" — route results through AppHolder
instead; (2) biometric 1.1.0 drags fragment < 1.3 (breaks ActivityResult)
— explicit `fragment-ktx` 1.8.x is in the catalog, keep it.
⚠️ Release builds run lintVitalRelease, which catches what debug builds
don't — run `assembleRelease` locally before shipping build-file changes.

## Ground rules

- The JSON-RPC contract is frozen: deltachat **JSON Lines over stdio/socket**,
  **positional params** (`#[rpc(all_positional)]`), one yerpc session per
  connection. Never introduce a second API surface.
- The PWA (`/app`) stays build-less and untouched — different client, same core.
- `.so` files are NEVER committed (`jniLibs/**` gitignored; same rule as the
  Tauri `binaries/`). Build per machine/CI.
- Repo-wide: no private relay hostnames/IPs in tracked files or issues.
- Parallel sessions work in this repo: `git status` first, commit named paths
  only, never stash. Pushes go through a temp worktree cherry-pick onto
  `origin/master` (local master runs behind with duplicate commits).

## Build & verify (WSL is the build host)

Every gradle run MUST start with a fresh tar-sync — skipping it once shipped
stale jniLibs and cost an hour:

```sh
wsl.exe -e bash -lc 'export JAVA_HOME="$HOME/.local/jdks/temurin-21"; export PATH="$JAVA_HOME/bin:$PATH"; export ANDROID_HOME="$HOME/Android/Sdk"
tar --exclude=velta-kmp/.gradle --exclude=velta-kmp/build --exclude=velta-kmp/native -cf - -C /mnt/c/Users/pave/Velta/velta velta-kmp | tar -xf - -C ~/velta-kmp-build/
cd ~/velta-kmp-build/velta-kmp
./gradlew --no-daemon :composeApp:desktopTest :composeApp:assembleDebug :composeApp:packageDistributionForCurrentOS'
```

Full local gate = desktopTest + assembleDebug + desktop package, then CI green
(`gh run list --workflow build-kmp.yml`). The real-binary IT needs
`VELTA_KMP_RPC_SERVER=~/velta-core-build/core/target/release/deltachat-rpc-server`
(linux build lives in `~/velta-core-build/core/`).

### Android shim rebuild (only when native/rpc-shim changes)

The Cargo.toml carries a size-tuned release profile (lto +
codegen-units=1 + opt-level=s + strip): 56/64 MB → 25.9/28.7 MB per ABI.
⚠️ The FIRST build after a profile/dependency change recompiles the whole
core under LTO (~10 min in WSL); after that, shim-only edits are ≈ 11 s.

```sh
export NDK=$HOME/Android/Sdk/ndk/29.0.13846066; export TC=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin
export RANLIB=$TC/llvm-ranlib AR=$TC/llvm-ar PATH="$TC:$PATH"
export CC_aarch64_linux_android=$TC/aarch64-linux-android24-clang AR_aarch64_linux_android=$TC/llvm-ar
export CC_x86_64_linux_android=$TC/x86_64-linux-android24-clang AR_x86_64_linux_android=$TC/llvm-ar
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$TC/aarch64-linux-android24-clang
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER=$TC/x86_64-linux-android24-clang
cargo build --release --target aarch64-linux-android --target x86_64-linux-android
$TC/llvm-strip <so> -o <stripped>   # 80 MB → 56/64 MB
# copy into composeApp/src/androidMain/jniLibs/{arm64-v8a,x86_64}/libvelta_rpc_shim.so
```

Ring's cc-probe needs the `CC_<target>`/`AR_` vars — NDK 29 ships only
API-suffixed wrappers, no bare `aarch64-linux-android-clang`.

### Emulator flow

Windows-side JDK is 26 (too new for Gradle 8.14) — build the APK in WSL,
copy it to `C:/Users/pave/Velta/build-artifacts/`, install via the
android-emulator plugin (⚠️ Windows adb cannot read `/mnt/c/...` paths; the
plugin handles it), then raw adb
(`C:/Users/pave/AppData/Local/Android/Sdk/platform-tools/adb.exe`):

```sh
adb -s emulator-5554 shell "am force-stop org.velta.kmp; input keyevent KEYCODE_WAKEUP"
adb -s emulator-5554 shell "am start -n org.velta.kmp/.MainActivity"
adb -s emulator-5554 logcat -d | grep velta-kmp     # println only; shim stderr is INVISIBLE
```

Debugging on-device: shim stderr never reaches logcat — rely on the shim's
distinct return codes (-1 generic, -2 bind, -3 accounts), the Kotlin
`velta-kmp:` println lines, and the connect-ok line
(`velta-kmp: connect ok — core v2.66.0, ...`) that lands on every successful
handshake.

Android lifecycle (P4): `AppHolder` holds ONE process-wide `AppModel`
shared by the UI and `VeltaForegroundService`; `connect()` is idempotent.
Verification recipes:

```sh
# Foreground service held after backgrounding:
adb shell "input keyevent KEYCODE_HOME; sleep 2; dumpsys activity services org.velta.kmp" | grep isForeground
# Restart-on-kill: crash the process, the sticky service rebuilds the core:
adb logcat -c; adb shell "am crash org.velta.kmp"; sleep 12
adb shell pidof org.velta.kmp            # NEW pid
adb logcat -d | grep "connect ok"        # service-side handshake line
```

⚠️ `VeltaForegroundService.onDestroy` fires on EVERY return to the
foreground (MainActivity.onStart stops the service — battery pattern),
NOT only on app exit — never tear the core down there (a shutdown there
killed the RPC client mid-check_qr: Join screen showed "rpc client
closed"). The shim dies with the process; `AppModel.shutdownCore` is for
explicit teardown only.
Gotchas: a fresh install shows the POST_NOTIFICATIONS dialog which BLOCKS
everything (`GrantPermissionsActivity` on top) —
`adb shell pm grant org.velta.kmp android.permission.POST_NOTIFICATIONS` +
BACK clears it; `pidof`/`ps` read empty during that transition; emulator
`/tmp` does not survive between wsl.exe calls; Windows-side JDK is 26 —
never run Gradle on the Windows side.

## UI (#321 visual shell + N3 glass)

- Chat-list header: centered logo + search ONLY (toggles the Search side
  view — the icon swaps to close while it is open, web syncHeaderButtons),
  then the relay strip. One segment per transport with its OWN state color
  (web parseConnectivityHtml port — see `ui/RelayStates.kt`; empty parse =
  the single account-connectivity segment). **The 6dp meter is the only
  tappable part** (opens Relays): the zone's 10dp padding bands are visual
  spacing, NOT hit area — padding before clickable, or the bands swallow
  the category chips' taps below. Pull-down >32dp while the list sits at
  the very top overlays the web's `.relay-detail` chips for 4s (web
  pull-open): one pill per segment — `maskRelayDomain` ("d13*.dev" — first
  3 chars + star + last dot label) + segment title, the send relay marked
  with an envelope in its own state color. Both list gestures ride the
  ChatsView CONTAINER, not the LazyColumn — empty categories render the
  empty-state Box instead of a list and the gestures must survive.
- Chat-list bottom action bar (`ListBar`, .list-bar port, #329 COMPLETE):
  solid bgSidebar + 1dp top border, IN-FLOW (not glass), stretch 46dp
  buttons, icons at --ico-4 = 22dp. Chats/Contacts/Calls/QR toggle side
  views via `AppModel.toggleListView` (web setListView: tapping the
  active view returns to chats; active = accent ink + 2dp inset bottom
  accent line, top corners squared); "+" = the .bar-accent square (accent
  bg, radius 8 — #109: never a tab) opening the New-chat view; Menu rides
  the DropdownMenu (Settings, Relays, Accounts, Invite — NO Refresh item:
  the web menu has none and list reloads are event-driven). Android
  back inside a side view returns to chats (`PlatformBackHandler(enabled)`)
  — the expect/actual grew an `enabled` parameter for this.
- Category chips (#57, web .chat-cats, `CategoryChips`): All / Unread /
  People / Groups / Channels / Bots / System, equal-flex pills (11.5sp,
  active accent bg + onAccent ink). `chatCategoryOf` lives in
  `ChatCategory.kt` (pure, vector-tested): self-talk/device/deaddrop →
  system, Group → groups, Mailinglist/Broadcast → channels, single → bots
  (ContactObject.isBot) or people. Unread is a filter across the kind
  buckets, not a bucket. Selection persists under the web's
  `velta-chat-category` key; bot flags come from ONE lazy `get_contacts`
  call (web ensureContactBots) — a failed fetch keeps the old flags.
  **Swipe gesture**: a horizontal drag on the chats list steps one chip per
  gesture, left = next / right = previous (`swipeCategoryStep`, pure fn in
  ChatCategory.kt — 48px threshold, horizontal must dominate vertical by
  1.4×, the web's own axis ratio; shallower drags are scrolls and pass
  through). Works on empty categories too — the detector rides the
  container, not the list.
- Main-screen side views (rendered IN PLACE of the list, web setListView):
  Contacts (`get_contacts` rows + the `velta-known-contacts-only` toggle,
  default on; tap → create_chat_by_contact_id → open), Calls (LOCAL log
  under `velta-call-log`, capped 30, fed by the core `CallEnded` event —
  the core stores no call log), Your QR code (`get_chat_securejoin_qr_code_svg`
  → the code text IS the canonical invite link; **per-domain tabs**
  (web mountInviteDomains: `velta.cc` default-first + i.delta.chat /
  i.deltachat.id / i.gluek.info — `AppModel.INVITE_HOSTS`, selection
  persisted under `velta-invite-domain`, the default stores by REMOVING
  the key): `rewriteInviteHost` slices the canonical `https://i.delta.chat/#`
  prefix and re-hosts the payload byte-identical (velta.cc → the
  `/join/?` universal form, mirrors → `/host/#`); **non-i.delta.chat
  domains render `BrandedQrSquare`** — the web's brandedQrSvg: LOCALLY
  built white 512² square, 48px quiet zone, matrix scaled 416/size, the
  VELTA_QR_LOGO badge dead-center (white ring r56, #1c1c1c disc r48, V
  mark 84×84); the **i.delta.chat tab keeps the core's 515×630 card**
  (`InviteQrCard`: QR at translate(57.5, 75) scale 400/size, caption
  "Scan to chat with {name}" at baseline 515, identity disc centered on
  the QR at (257.5, 275), Velta mark in the footer slot). Link chip +
  Copy/Share ride the SELECTED domain's link (injected `shareText` seam,
  ACTION_SEND on Android); Scan tab reuses ScanActivity, desktop hides
  it), Search (live name filter, min 2 chars, first 30 + the Archived tab
  = `get_chatlist_entries` with listFlags=1, DC_GCL_ARCHIVED_ONLY), and
  New chat ("Start something", web newChatOptions order — new chat
  (single-pick), new group (multi-pick + name dialog + Admin group switch
  → create_group_chat / create_group_with_admin + add_contact_to_chat),
  new channel (create_broadcast), join invite / add relay / add account →
  Join screen. The P2P-only "New local group" never shows — KMP has no
  P2P flag). Row previews ride `listPreview` and for media types pass
  `summaryText2` through UNCHANGED — the core's summary already embeds
  the type emoji (`summary.rs get_summary_text_ext`, add_type_emoji:
  "📷 help", "🎥 Video", "📎 file – text"; re-prefixing showed one
  received photo as "📷 📷 caption"); the "Draft:" prefix renders red
  UNTRANSLATED (the core owns that string; the web hardcodes it too —
  only "Contact request:" is an L.t key).
- Chat-list rows = the web .chat-item anatomy: 48dp avatar tile at 22%
  radius (`AvatarTile` — identity matrix for key-holding 1:1 peers, a
  single contact's PHOTO sits ON the matrix (inset 19.17%, 2.5% padding,
  #1c1c1c ring, radius 24.3% — web avatar.js/main.css:1754), saved/device
  135° #5aa2e6→#8774e1 gradient tiles with avatarStar/device icons at 55%,
  group photos full-bleed, contact-color/Prism initials otherwise),
  15.5sp/600 name + 12sp formatListTime stamp (today
  HH:MM, Yesterday, weekday < 7d, "MMM d", with year), ticks from
  summaryStatus (18-28 = outgoing: clock/warn-red/tick1/tick2-read) before
  a 14sp dim preview, right slot priority unread > pin > mute, badge =
  accent-2 pill (min 23dp, 12.5sp/600, "999+" cap; muted variant =
  textDim bg + **onBadgeMuted** ink — a generated token since the
  velta.cc/design pass; light theme = #f4f4f4, the dark ink read 2.6:1).
- Design-page contracts applied (velta.cc/design, generated from
  main.css): chips' active ink = **onAccentChip** (identical to onAccent
  in every theme today — the token exists so a future split can't break
  silently); `VeltaDialog` = the web .modal contract (centered radius-16
  bgSidebar card w/ 1px border over a 45% scrim, width ≤420dp; FULL-SCREEN
  below a 600dp window width like the web's ≤600px breakpoint; ONE filled
  accent confirm + text cancel; scrim/back dismiss; text fields use
  placeholder hints, never floating labels); `Modifier.rowSurface(...)`
  = the web states contract — shared interaction source with
  `.clickable(indication = null)`, draws hover bgHover / 2dp focusRing
  outline / selectionBg (web: "hover and focus change surfaces, never
  text"); chips pass `hover = false` (their hover changes ink).
- Settings screen (#321 step 5): theme radios (Auto/Dark/Light/Brutal) +
  "Pure black (AMOLED)" flag shown only while the effective theme is dark
  (AMOLED layers on dark — `veltaEffectiveMode` pins app.js applyTheme),
  accent presets + custom #hex through `Accent.derive` (WCAG-checked),
  language radios (en/fr/ru, native names) applying LIVE (no reload —
  compose state, not stamped DOM). Persisted via the `CorePlatform.pref`
  seam under the web's OWN localStorage keys (`dw-theme`, `velta-amoled`,
  `velta-accent`, `velta-lang`): SharedPreferences on Android,
  java.util.prefs on desktop; "en" and the stock accent store by REMOVING
  the key (web convention).
- Settings screen (#321 step 5): theme radios (Auto/Dark/Light/Brutal) +
  "Pure black (AMOLED)" flag shown only while the effective theme is dark
  (AMOLED layers on dark — `veltaEffectiveMode` pins app.js applyTheme),
  accent presets + custom #hex through `Accent.derive` (WCAG-checked),
  language radios (en/fr/ru, native names) applying LIVE (no reload —
  compose state, not stamped DOM). Persisted via the `CorePlatform.pref`
  seam under the web's OWN localStorage keys (`dw-theme`, `velta-amoled`,
  `velta-accent`, `velta-lang`): SharedPreferences on Android,
  java.util.prefs on desktop; "en" and the stock accent store by REMOVING
  the key (web convention).
- Composer = web footer.composer (48dp icon buttons at 26dp icons,
  48dp-min 16dp-radius input wrap on bgSidebar + 1dp border, naked
  BasicTextField 15.5sp/1.3, armed-send tint). Attach menu (web
  chat-view.js): Photo / Video / Camera (FileProvider capture) / File
  (SAF mime pre-filter) / Stickers. Bubbles = .bubble CSS (radius 14,
  6dp sender-side tail, 7/10/6 padding, bgBubbleIn/Out, width
  min(480dp, 90%), 2dp shadow, 4dp list gap): group incoming = 42dp
  `MessageAvatar` (Prism tile) + 13.5sp/600 sender name INSIDE the bubble
  (web .msg-sender is a bubble child, stickers keep it); meta row =
  11.5sp `msgMetaSize` in textMetaIn/Out, tick tints 28→ticksRead /
  24→danger; stickers = transparent bubble, no shadow/padding, 175dp cap;
  media bleeds 5dp past the padding (`mediaBleed` layout modifier —
  measure +10dp headroom, report child − 2×bleed, place −bleed), 320/450
  caps + radiusMedia clip + dims-reserved placeholder; video/audio/file
  cards carry size + duration chips from the wire (`MessageObject`
  fileBytes/duration/dimensionsWidth/Height); reactions live INSIDE the
  bubble as bgReply chips (accent border on the own reaction); isInfo
  messages render as .service-msg mono pills, day chips as .day-chip.
  Quote block = .msg-quote (2.5dp accent bar, single-line ellipsis, tap
  scrolls when the quoted message is in the loaded window —
  fetch-then-jump is #327); quote text inks are theme-keyed per web
  main.css 907-912/3393 (light = #4d5a68 both sides, brutal out =
  #3d3410 — LocalVeltaThemeMode exposes the resolved mode).
  Markdown = Markdown.kt + BareLinks.kt + Mentions.kt (invites →
  .invite-card → Join flow; code spans click-to-copy).
- **Chat screen gestures** (`touchGesturesEnabled` expect/actual in
  ui/PlatformBack.kt — Android on, desktop off, the web _mobileGestures
  coarse-pointer gate): ① category swipe (above); ② bubble reply swipe —
  drag a bubble right, engages 12dp, live-follows to 64dp via
  graphicsLayer, haptic tick at the 48dp commit line (re-armed below),
  release commits `startReply`; consumes changes once engaged (locks the
  list scroll = web preventDefault); ③ history back swipe — drag the
  list left, the whole LazyColumn live-follows, commit at
  −min(72dp, 28% width) → backToChatList. List-level detectors run on
  PointerEventPass.Initial with `positionChangeIgnoreConsumed()` (the
  list's scroll/overscroll consumes deltas; measure pre-consumption);
  the bubble detector runs Main pass and gates reply-vs-back by
  DIRECTION. The web's .16s/.18s slide animations are skipped (commit
  switches screens, cancel snaps).
- **Chat header** = web velta-chat-head: 42dp AvatarTile (identity
  matrix / photo / Prism tile by chat kind), 16px/600 name, status line
  (`chatHeadStatus`: "your personal space" / "local device messages" /
  "{n} members" / "{n} subscribers" / "bot" / "last seen {when}" via
  relativeLastSeen — no typing indicator (#332) and no online flag: the
  KMP contact model has no online field). Data rides `AppModel.chatHead`
  (ChatHead): set synchronously from the ChatListItem on open (color,
  avatar, identity fingerprint, bot flag), then memberCount (fullChat
  contactIds) and lastSeen (contact fetch) land async. The whole info
  zone opens the Profile screen; the right-edge button is the web's
  chat-menu dots (dotsVertical) for ALL chats — groups had no header
  entry point before. Call buttons stay hidden (no calls in KMP) and
  search-in-chat ships no dead button (no KMP in-chat search yet).
- One GraphicsLayer records the scrolling content. Header and composer are
  overlay siblings that sample it. `rememberGraphicsLayer` lives in
  `androidx.compose.ui.graphics` (CMP 1.9), not the `layer` package.
  Backdrop boxes use `matchParentSize`. A `fillMaxSize` child expands the
  plate over the list.
- API 33 shader: rounded-slab Snell bevel, IOR 1.5, bevel 46% of the short
  side, peak shift 18% of the short side, clipped to the plate. The header
  plate includes the status-bar inset, so the lens runs under the status
  icons. Composer radius is 22dp. The lens is off while a reply, attachment,
  or message-action bar is showing.
- `MainActivity` `windowSoftInputMode` is `adjustNothing`. The chat screen
  pads the host once with `ime` union `navigationBars`. Do not add a second
  IME padding, and do not switch to `adjustResize` without a phone check:
  this edge-to-edge window does not shrink when the keyboard opens.

## Protocol facts (verified against vendored core 2.66)

- Chat-list wire extras decoded since #329: `ChatListItem.chat_type`
  (PascalCase "Single"/"Group"/"Mailinglist"/"OutBroadcast"/"InBroadcast"),
  `summary_status` (18-28 = outgoing), `last_message_type` (media preview
  prefixes), `dm_chat_contact` (known-contacts + bots). `ContactObject`
  carries camelCase `isBot`. `get_chatlist_entries` listFlags=1 is
  DC_GCL_ARCHIVED_ONLY (constants.rs:53 — the web passes 1 for its
  Archived tab). `get_chat_securejoin_qr_code_svg(acct, chatId|null)`
  returns `[code, svg]` — the code IS the canonical invite link.
- Creation RPCs (web rpc-core createChat): single = `create_chat_by_contact_id`,
  group = `create_group_chat(acct, name, false)` + `add_contact_to_chat`
  loop, admin group = `create_group_with_admin` (#177/quilt #19), channel
  = `create_broadcast(acct, name)`. The core's `CallEnded{msg_id, chat_id}`
  event feeds the local call log.
- `get_system_info` → map; version key is **`deltachat_core_version`**.
- Responses carry `"jsonrpc":"2.0"`; errors are `{"id","error":{"code","message"}}`.
- Events = **long-poll `get_next_event`** driven in a loop (BaseDeltaChat pattern).
- Persistence = the accounts dir (`DC_ACCOUNTS_PATH`): `get_all_account_ids`,
  `get_account_info` kind `"Configured"` / `"Unconfigured"` (no `isConfigured`
  on the wire; that field is fixture-only). The core's selected account
  persists across restarts. Resume of a configured account calls
  `select_account` and `start_io_for_all_accounts`, same as the web client's
  init. An unconfigured-only account stays on Login and does not select or
  start IO. `get_all_accounts` returns every Account in one call;
  `add_account` auto-selects the new account.
- `RpcClient.call` bounds ordinary RPCs at 30s by default
  (`RpcException(method, code -2)` names the METHOD, not `id=N`);
  long-running calls opt out with `timeoutMs = null`: `get_next_event`
  (unbounded long-poll), `add_transport_from_qr`, `add_transport`,
  `delete_transport`, `configure`, `secure_join`, `background_fetch`.
  The shim IS restartable in-process (`startCoreOnce`/`stopCoreOnce`):
  on a dead client the model drops to "core connection lost" and
  reconnects to the cached port — no process kill. A second `startCore`
  is refused (cached-port singleton).
- Modern write path is draft-based:
  `misc_set_draft(accountId, chatId, text?, file?, filename?, quotedMessageId?, viewType?)`
  → `misc_send_draft(accountId, chatId)`; `get_draft`/`remove_draft` alongside.
  The core dedups attachment files into its blobdir itself
  (`set_file_and_deduplicate`) — never copy blobs client-side.
- `send_reaction(accountId, messageId, [emoji])` (re-send toggles off).
- Connection lifecycle (N2): a transport exit makes `RpcClient` fail all
  in-flight calls, mark itself dead (post-death `call()` throws instantly)
  and fire `onDead` — but a deliberate `close()` never counts as death.
  `AppModel.onCoreDead` drops the UI to "core connection lost" and retries
  once after 2 s. `RpcShim.startCoreOnce` returns the CACHED loopback port:
  each JNI `startCore` would spawn a second core on the same accounts dir,
  while the shim itself is a long-lived accept-loop server that survives
  client disconnects — the port stays valid for reconnects.
- Message-event bursts are coalesced: `MsgsChanged`/`IncomingMsg`/
  `MsgsNoticed`/`MsgDelivered` mark chats dirty and flush ONE list/chat
  reload 200 ms after the burst started (the model scope is
  Dispatchers.Default → the dirty set is lock-guarded).
- `add_transport_from_qr` on a domain that ALREADY has a transport: the
  join flow SKIPS entirely (no delete, no add — straight to the chat
  list; the strip re-colors as confirmation). The earlier delete-then-
  re-add design could kill a working account's only transport if the
  add failed. The core caps transports per account; a "maximum number
  of relays (5)" error routes to the Relays screen (`relaysNotice`).
- Invites: `check_qr(accountId, qr)` parses OFFLINE — kind-tagged oneOf
  ("text" for garbage, "account"+domain for `DCACCOUNT:` invites,
  "askVerifyContact/Group/Broadcast" for secure-join); `secure_join` needs io;
  `add_transport_from_qr` onboards relays. In-message invite LINKS go
  through `parseInviteLink` first (invites.js port): it returns the
  CANONICAL `https://i.delta.chat/#<fp><payload>` — the core only parses
  that scheme, so mirror hosts (velta.cc, i.gluek.info) MUST be
  normalized before check/secure-join, and both forms require the final
  40-hex fingerprint. Percent-decoding is percent-ONLY ('+' stays
  literal; java.net.URLDecoder is both crashy on `%zz` and wrong).
  md-link `[label](invite)` renders a plain anchor (cards are
  bare-URL-only, web markdown.js); the bubble tap handler intercepts
  invite hrefs (bindInviteInterception parity).
- Relays: `list_transports` → Vec<EnteredLoginParam> (sending transport
  first, quilt #11), `get_server_metadata` → map addr→metadata (quilt #15),
  `delete_transport(addr)`. ⚠️ `set_transport_enabled` does NOT exist yet
  (quilt #24, issue #189).
- Push: **`velta_set_push_device_token` is a SHIM-ONLY RPC** —
  `Accounts::set_push_device_token` is not on the JSON-RPC surface; the
  shim intercepts it before yerpc dispatch (desktop sidecar rejects it).
  Token = `webpush:<url>|<pubKey>|<auth>`; `background_fetch(timeout_s)`
  IS on JSON-RPC. End-to-end push still needs the relay side
  (PLAN-UNIFIEDPUSH.MD items 1–3).
- Invites/QR: `check_qr(accountId, qr)` parses OFFLINE — kind oneOf
  ("text" for garbage, "account"+domain for `DCACCOUNT:`,
  "askVerifyContact/Group/Broadcast" for secure-join). The KMP scan flow
  hands the decoded payload straight to the model (no ActivityResult).
- App lock (phase-4 port): lock ON → cold start refuses the core
  (`getOrCreateDek` returns null); the DEK lives in an auth-window wrap
  (`dbkey.bio`, 30 s Keystore validity after a prompt); unlock = prompt →
  `unlockDek` inside the window → `spawnRpcServerWithKey(dir, dek)`.
  PIN/Argon2id fallback deferred.
- IncomingMsg events carry `chat_id`/`msg_id` (snake case on the wire —
  AppModel probes both casings); notifications post per chat
  (notification id = chatId.toInt()) on the `messages` channel, skipped
  for the on-screen chat and muted chats; tap deep-opens via the
  MainActivity `chatId` extra (singleTop) -> `pendingOpenChatId`.
- Message timestamps on the RPC surface are unix SECONDS, not millis —
formatTimestamp/formatDateHeader must use Instant.ofEpochSecond (reading
them as millis rendered every day header as Jan 1970; TimestampTest
guards it). ⚠️ THE ONE EXCEPTION: `ChatListItem.lastUpdated` is
MILLISECONDS on the wire (web rpc-core.js:855 maps `lastTs` with that
exact comment) — reading it as seconds rendered every chat-list stamp
as "Feb 3, +58838" (FormatTimeTest guards the formatter side).
- The chatlist summary `summaryText2` ALREADY embeds the media emoji
(core summary.rs get_summary_text_ext, add_type_emoji — "📷 help",
"📷 Image", "🎥 Video", "📎 file – text"; Gif/Sticker get none) —
client previews must pass it through for media types, never re-prefix
(one received photo rendered as "📷 📷 caption"; web rpc-core.js
carries the same no-re-prefix rule).
- Per-transport strip (web parseConnectivityHtml port, `ui/RelayStates.kt`):
`get_connectivity_html` is the ONLY live per-transport source (🐴 ceiling
noted on the web too — no per-transport JSON-RPC) — one `<li class="transport">`
per relay with colored dots, worst dot wins, the SMTP dot OUTSIDE the list,
the #79 `smtp-via` span. The #76 shell-side probe is `probeRelayReachable`
expect/actual (jvmCommon: HTTPS GET 6 s — cast to **javax.net.ssl**, android.jar
has no java.net.HttpsURLConnection), 60 s min gap, failing ≥10 min = offline
grey, failing-while-green = unreachable amber. `ScriptedRpcTransport` answers
`get_connectivity_html` with "" by default so scripted tests never hang the
strip (an unscripted call would leave refreshRelayLine suspended forever).
- Invite-domain keys ride the web's localStorage names via CorePlatform.pref:
`velta-invite-domain` (selected QR domain; "velta.cc" stores by REMOVING the
key), builtin hosts = velta.cc / i.delta.chat / i.deltachat.id / i.gluek.info
(web BUILTIN_HOSTS, invites.js:15). Extra user domains (drawer registry,
`velta-invite-hosts`) not ported.
- Message state numbers (core/src/message.rs): 10=InFresh, 13=InNoticed,
  16=InSeen, 19=OutDraft, 20=OutPending, 24=OutFailed, 26=OutDelivered,
  28=OutMdnRcvd. Wire casing: `MessageLoadResult` kind is **"message"**
  (enum-level camelCase) — a PascalCase filter silently drops every real
  message; `ChatListItemFetchResult` kinds ARE PascalCase ("ChatListItem").
- The server exits when stdin reaches EOF (sidecar); the in-process shim has
  no such trap. Probe a real binary with `(printf '...'; sleep 3) | binary` —
  instant EOF skips the answer.
- `--openrpc` prints the whole method spec — ground truth for signatures.

## Test conventions

- The QrEncode round-trip test rasterizes at 8 px per module: ZXing's
  HybridBinarizer cannot binarize a 37-px synthetic symbol (the plain
  QRCodeWriter test passes only because it renders 256 px). If a new QR
  test fails with NotFoundException, scale the raster first.
- Porting arithmetic from the JS files: three bugs cost a debug cycle in
  the qr-encode.js port — (1) `rsMul` masks `z & 0xff` only ON RETURN
  (masking inside the loop feeds `z >>> 7` different bits), (2) the
  zigzag loop MUTATES `right` at the timing column (`right = 6 → 5`, then
  `-2` lands on 3, not 4 — a local `val r = if (right == 6)...` shifts
  every later column pair), (3) byte-mode `numChars` counts BYTES, not
  UTF-16 units (an astral char is 1 char but 4 numChars). Diff against
  the real `app/js/qr-encode.js` via node before re-deriving by eye.
- Porting GEOMETRY (SVG/canvas → Compose): read the GENERATOR SOURCE
  directly, never a summary — a misread QR card spec cost a broken screen
  (QR y=255 vs the real translate y=75). And keep POSITIONS and SIZES
  separate: computing a size from a `cx(x)`-style position helper silently
  includes the letterbox offset once one exists (the QR modules rendered
  ~14% oversize and collided with the caption). Same class as the zigzag
  `right`-mutation trap: layout math that holds pre-offset breaks after.
- On-device "it didn't change" checks: `install -r` racing a live app
  process can leave the OLD UI on screen even with lastUpdateTime
  updated — force-stop + relaunch before believing a stale screenshot.
- `runBlocking`, never `runTest`, for anything touching real threads/processes
  (virtual time fires timeouts while real IO waits).
- Calls under test go in a **SupervisorJob scope** — a plain `async` child
  failing cancels the `runBlocking` parent before `assertFailsWith` can run.
- Never assert on request ORDER across coroutines; map method → id from the
  recorded sent lines. Poll loops must RE-COMPUTE their indexes each pass
  (a captured `-1` before the coroutine runs = eternal timeout).
- `ScriptedRpcTransport` (method → result JSON) for client/facade tests; a
  method missing from the script never answers = realistic long-poll. When a
  poll times out, check SCRIPT COVERAGE first — a missing entry hangs the
  call silently. Dump requests/status on timeout (DIAG pattern). A result
  starting with `ERROR:` is answered as a JSON-RPC error with that message.
- `FakeRpcTransport` (RpcClientTest) can simulate a core death via
  `exit()` — fires the transport's onExit with no responses; assert
  in-flight calls fail, post-death calls throw, `onDead` fired.
- Fixture JSON must match the WIRE, not the Rust struct names: probed truth
  is `kind:"message"` (lowercase) vs `kind:"ChatListItem"` (PascalCase) —
  reading serde attributes instead of probing shipped a silent drop-everything
  bug once. Raw-string JSON concatenation doubles quotes — write one string.
- `runBlocking` + real PNG fixtures for the decoders (DecodeImageTest).
- Prism/identity parity vectors (PrismIdentityTest) come from the WEB
implementation (name-color.js / avatar.js) — the web is the source of
truth. If a vector fails, suspect the port, never the vector: hashing
must feed only the high UTF-16 surrogate for astral code points, and the
identity used-color rule is NAME-based (Magenta and Fuchsia share an RGB
but are distinct pool entries). Re-derive vectors with node when in doubt.
- `identityFingerprintFromEncrInfo` is web `parseFingerprint`: split
  `get_contact_encryption_info` on blank lines first (the text has the
  self key AND the peer, sorted by fingerprint), then blockFpr joins the
  5-group windows inside ONE block. Taking the first 40 hex of the whole
  string paints the self key on the contact whenever it sorts first.
- Generated-file tests are the CI gate for four generators
  (`VELTA_GEN_NO_WRITE=1` re-run vs the committed file): theme tokens,
  icons, string packs. The strings generator ALSO asserts every used
  `L.t` key exists in BOTH web packs — a key missing there is a porting
  bug (wrong casing), not a test failure to relax. ⚠️ when scanning for
  call sites, strip whole-line `//` comments FIRST — the generated
  files' own headers mention `L.t("…")` and would feed themselves back
  in as a "used key".
- Delegated-property `var x by mutableStateOf` + an explicit `fun setX`
  in the same class = JVM signature clash — name the API like the web
  handlers (`onSetTheme`/`onSetAmoled`/`onSetAccent`/`onSetLang`).
- `Color(red:, green:, blue:, alpha:)` takes Float, not Double; a
  positional arg after a named one is a compile error; `Velta.tokens`
  is a @Composable getter — hoist it to a local val before any
  drawBehind/drawing lambda.
- SettingsTest pins the appearance guarantees: `veltaEffectiveMode`
  AMOLED layering, `Accent.derive` contrast floors (4.5 / 7 / 4.6,
  ticks 3) on real token sets, brutal BRUTAL_KEYS restraint, prefs
  round-trip through a NEW model, and the L.t fallback chain.

## Desktop run

```
VELTA_KMP_RPC_SERVER=<path to deltachat-rpc-server> ./gradlew :composeApp:run
```
Accounts land in `~/.velta-kmp/accounts`. The Tauri repo's 2.63 exe
(`velta-app/src-tauri/binaries/`) covers every method the client uses today.
