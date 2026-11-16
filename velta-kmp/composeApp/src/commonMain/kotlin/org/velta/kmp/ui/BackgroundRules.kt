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

    /** Core-side bound of one `background_fetch` (seconds). */
    const val FETCH_SECS = 30.0

    /** The whole job: a cold core can take ~20 s before the 30 s fetch
     *  (stable FETCH_MAX_SECS = 55). */
    const val JOB_MAX_MS = 55_000L
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
