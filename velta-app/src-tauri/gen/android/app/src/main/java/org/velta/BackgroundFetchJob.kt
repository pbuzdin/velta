package org.velta

import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.Context
import android.util.Log

// Scheduled-fetch fallback (#52 Layer 3): runs a bounded background fetch
// while the app is hidden even without a UnifiedPush distributor, and covers
// OEM freezers that cut the IDLE socket of a backgrounded process — a
// JobScheduler job unfreezes the process for its duration (the official
// Delta Chat client delivers through the same pattern). The wake itself is
// the push path reused: JNI into the Rust core, which runs one bounded
// background_fetch whose events surface through the background poller and
// go out as notifications (pushWakeup in lib.rs).
//
// The job holds its slot until the core reports the fetch finished
// (fetchBlocking on a worker thread), then finishes. jobFinished with
// reschedule=false: the periodic schedule stays with the JobScheduler. If
// the system stops the job early, onStopJob interrupts the fetch and asks
// for a reschedule.
class BackgroundFetchJob : JobService() {
    // lib.rs: blocks the calling thread until the core's background_fetch
    // finished (or maxSecs); stopFetch interrupts it.
    private external fun fetchBlocking(maxSecs: Int): Boolean
    private external fun stopFetch()

    // Drawer "Use background connection" (BgPrefs). OFF: this scheduled job
    // is the background connection — finish immediately without waking the core.
    private fun backgroundConnectionEnabled(): Boolean = BgPrefs.backgroundConnectionEnabled(this)

    // Jobs whose slot the system took back (onStopJob): their worker must
    // not call jobFinished any more.
    private val stopped = java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<Int, Boolean>())

    override fun onStartJob(params: JobParameters?): Boolean {
        if (!backgroundConnectionEnabled()) {
            Log.d(TAG, "scheduled fetch: skipped (background connection off)")
            return false
        }
        Log.d(TAG, "scheduled fetch: waking the core")
        // A frozen-then-killed process has no core yet: start it headless.
        if (!VeltaCore.ensureStarted(this)) {
            Log.e(TAG, "core not running - skipping the fetch")
            return false
        }
        val key = (params?.jobId ?: JOB_ID)
        stopped.remove(key)
        // The fetch is synchronous on a worker thread: the job finishes when
        // the core reports it done (not after a fixed 28 s), so the process
        // is released as soon as the work is over.
        Thread({
            val done = try {
                fetchBlocking(FETCH_MAX_SECS)
            } catch (e: UnsatisfiedLinkError) {
                Log.e(TAG, "native lib not loaded - core not running", e)
                false
            }
            Log.d(TAG, "scheduled fetch: finished (done=$done)")
            if (!stopped.remove(key)) {
                // The periodic schedule stays with the JobScheduler.
                jobFinished(params, false)
            }
        }, "velta-bg-fetch").start()
        return true
    }

    override fun onStopJob(params: JobParameters?): Boolean {
        // Stopped early (constraints lost, quota): interrupt the fetch and
        // ask for a retry; the worker skips its jobFinished.
        stopped.add((params?.jobId ?: JOB_ID))
        try {
            stopFetch()
        } catch (_: UnsatisfiedLinkError) {
        }
        Log.d(TAG, "scheduled fetch: stopped by the system, rescheduling")
        return true
    }

    companion object {
        private const val TAG = "BackgroundFetchJob"
        // background_fetch is bounded to 30 s core-side; the extra covers a
        // cold core that is still initializing (up to 20 s).
        private const val FETCH_MAX_SECS = 55

        // JobScheduler's minimum periodic interval is 15 minutes. Persistent
        // so the schedule survives reboots.
        const val JOB_ID = 0x564C // "VL"
        const val PERIODIC_MS = 15 * 60 * 1000L

        fun schedule(context: Context) {
            val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
            // Idempotent: re-scheduling an existing periodic job keeps it.
            val info = android.app.job.JobInfo.Builder(
                JOB_ID,
                android.content.ComponentName(context, BackgroundFetchJob::class.java),
            )
                .setRequiredNetworkType(android.app.job.JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(PERIODIC_MS)
                .setPersisted(true)
                .build()
            val result = scheduler.schedule(info)
            if (result == JobScheduler.RESULT_SUCCESS) {
                Log.d(TAG, "scheduled fetch job registered")
            } else {
                Log.e(TAG, "scheduled fetch job registration failed: $result")
            }
        }
    }
}
