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

    /** App lock is on and the core is not running: there is no key without
     *  the user, so a headless start cannot open the databases. */
    SkipLocked,
}

/** Whether a push or the periodic job may wake the core now. */
fun catchUpDecision(appLocked: Boolean, connected: Boolean): CatchUp =
    if (appLocked && !connected) CatchUp.SkipLocked else CatchUp.Fetch
