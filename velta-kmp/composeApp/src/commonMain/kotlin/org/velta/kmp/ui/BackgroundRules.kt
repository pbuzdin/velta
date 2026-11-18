package org.velta.kmp.ui

/**
 * Background delivery (#358 "Background delivery"): what runs when the UI is
 * gone. Ported from Velta stable's Android shell (velta-app/src-tauri/gen/
 * android: BackgroundFetchJob, VeltaCore.ensureStarted) — the same shape as
 * Delta Chat Android's periodic FetchWorker. Pure rules, pinned by
 * BackgroundRulesTest; the Android JobService only wires them up.
 */
object BackgroundPolicy {
    /** JobScheduler's minimum periodic interval; the job is persisted, so
     *  the schedule survives reboots. */
    const val PERIODIC_MS = 15 * 60 * 1000L

    /** Stable's job id ("VL"). */
    const val JOB_ID = 0x564C

    /** Core-side bound of one `background_fetch` (seconds; stable
     *  BG_FETCH_TIMEOUT_SECS, lowered from 30). */
    const val FETCH_SECS = 15.0

    /** The whole job: a cold core can take ~20 s before the 30 s fetch
     *  (stable FETCH_MAX_SECS = 55). */
    const val JOB_MAX_MS = 55_000L
}

/** Events that can change the outgoing queue (lib.rs sending_queue_check). */
val SENDING_QUEUE_EVENTS = setOf("MsgsChanged", "MsgDelivered", "MsgFailed")

/**
 * Whether the silent "Sending…" card should change.
 * [postWhenBusy] posts while the queue is non-empty; otherwise the card
 * comes down only once sending has finished. Null leaves it as it is.
 */
fun sendingCard(finished: Boolean, postWhenBusy: Boolean, alreadyUp: Boolean): Boolean? = when {
    postWhenBusy && !finished && !alreadyUp -> true
    !postWhenBusy && finished && alreadyUp -> false
    else -> null
}

enum class CatchUp {
    /** Run start_io + one bounded background_fetch. */
    Fetch,

    /** "Use background connection" is off: no wake-up runs (stable
     *  background_fetch_once / startHeadless). */
    SkipOff,

    /** The UI is on screen and runs io itself; a fetch would only restart
     *  io under it (stable: "never compete with the UI"). */
    SkipForeground,

    /** App lock is on and the core is not running: there is no key without
     *  the user, so a headless start cannot open the databases. */
    SkipLocked,
}

/** Whether a push or the periodic job may wake the core now. */
fun catchUpDecision(
    appLocked: Boolean,
    connected: Boolean,
    backgroundConnection: Boolean = true,
    uiVisible: Boolean = false,
): CatchUp = when {
    !backgroundConnection -> CatchUp.SkipOff
    uiVisible -> CatchUp.SkipForeground
    appLocked && !connected -> CatchUp.SkipLocked
    else -> CatchUp.Fetch
}

/** Stable key (localStorage "velta-notify-bg"): "0" = off, missing = on. */
const val BACKGROUND_CONNECTION_KEY = "velta-notify-bg"

fun backgroundConnectionOn(raw: String?): Boolean = raw != "0"

/** The sync service may keep running (no UI): connection on and a core
 *  that can run. */
fun syncServiceRuns(backgroundConnection: Boolean, appLocked: Boolean, connected: Boolean): Boolean =
    backgroundConnection && !(appLocked && !connected)

/** After a fetch the job lingers this long so the event loop can post the
 *  notifications before the system freezes the process again (stable 1.5 s). */
const val FETCH_NOTIFY_GRACE_MS = 1_500L

/** Broadcasts that bring background delivery back without the UI (stable
 *  ScheduledAlarmReceiver: boot and app update start CoreService). */
val BOOT_ACTIONS = setOf(
    "android.intent.action.BOOT_COMPLETED",
    "android.intent.action.MY_PACKAGE_REPLACED",
)

/** After boot / update: re-arm the periodic job always; start the sync
 *  service only when a core can actually run (app lock needs the user). */
fun bootStartsSync(action: String?, appLocked: Boolean, backgroundConnection: Boolean = true): Boolean =
    action in BOOT_ACTIONS && !appLocked && backgroundConnection

// ── Polish (#358 Background delivery, item 5) ──

/** stable kick_maybe_network: at most one `maybe_network` per 3 s; a lost
 *  network needs nothing (the core notices dead sockets itself). */
const val MAYBE_NETWORK_MIN_GAP_MS = 3_000L

fun maybeNetworkDue(available: Boolean, connected: Boolean, nowMs: Long, lastMs: Long): Boolean =
    available && connected && nowMs - lastMs >= MAYBE_NETWORK_MIN_GAP_MS

/** stable battery-prompt.js: asked ONCE — any answer or close is remembered. */
const val BATTERY_DISMISSED_KEY = "velta-battery-opt-dismissed"

/** Ask only when known not exempt, never answered, not yet this run, with a
 *  configured account and the background connection on (KMP: without it
 *  there is nothing to keep alive). */
fun shouldAskBattery(
    exempt: Boolean?,
    dismissed: Boolean,
    askedThisRun: Boolean,
    configured: Boolean,
    backgroundConnection: Boolean,
): Boolean = exempt == false && !dismissed && !askedThisRun && configured && backgroundConnection

private const val DKMA = "https://dontkillmyapp.com/"
private val DKMA_MAKERS = mapOf(
    "xiaomi" to "xiaomi", "redmi" to "xiaomi", "poco" to "xiaomi",
    "huawei" to "huawei", "honor" to "huawei",
    "samsung" to "samsung",
    "oneplus" to "oneplus",
    "oppo" to "oppo",
    "realme" to "realme",
    "vivo" to "vivo",
    "asus" to "asus",
    "lenovo" to "lenovo",
    "motorola" to "motorola",
    "meizu" to "meizu",
    "nokia" to "nokia", "hmd global" to "nokia",
    "sony" to "sony",
    "google" to "google",
    "wiko" to "wiko",
    "blackview" to "blackview",
)

/** The dontkillmyapp.com page for a Build.MANUFACTURER value (index if unknown). */
fun dontKillMyAppUrl(maker: String?): String =
    DKMA_MAKERS[maker.orEmpty().trim().lowercase()]?.let { DKMA + it } ?: DKMA

/** Display name for the maker ("Xiaomi"), or "" when unknown. */
fun makerLabel(maker: String?): String =
    maker.orEmpty().trim().replaceFirstChar { it.uppercase() }

/** Notification permission (Android 13+): asked once, not on every launch. */
const val NOTIFY_PERMISSION_ASKED_KEY = "velta-notify-permission-asked"

fun shouldAskNotificationPermission(sdk: Int, granted: Boolean, askedBefore: Boolean): Boolean =
    sdk >= 33 && !granted && !askedBefore

/** One incoming message for a MessagingStyle conversation notification
 *  (stable Notifications.show / Delta Chat's look: chat title for groups,
 *  sender as the message's person, plain text). */
data class IncomingNotice(
    val accountId: Long,
    val chatId: Long,
    val chatName: String,
    val isGroup: Boolean,
    val senderName: String,
    val text: String,
    val timestampMs: Long,
    val chatAvatar: String? = null,
    val senderAvatar: String? = null,
)

/** Sender line: the override name (bots, mailing lists), else the contact. */
fun noticeSenderName(overrideSenderName: String?, displayName: String?, name: String?, fallback: String): String =
    overrideSenderName?.takeIf { it.isNotBlank() }
        ?: displayName?.takeIf { it.isNotBlank() }
        ?: name?.takeIf { it.isNotBlank() }
        ?: fallback

/** Body: the text, else the attachment kind ("Photo", "Voice message"…,
 *  localized by [t]), else [fallback]. */
fun noticeText(text: String, viewType: String, hasFile: Boolean, fallback: String, t: (String) -> String = { it }): String = when {
    text.isNotBlank() -> text
    hasFile || viewType !in setOf("Text", "Unknown") -> t(hiddenKindLabel(viewType))
    else -> fallback
}
