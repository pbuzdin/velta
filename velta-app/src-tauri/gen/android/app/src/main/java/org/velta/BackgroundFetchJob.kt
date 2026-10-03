package org.velta

import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.Context
import android.os.Handler
import android.os.Looper
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
// The job holds its slot for FETCH_GRACE_MS so the OS does not refreeze the
// process while the async fetch (bounded to 30s shell-side) is running,
// then finishes. jobFinished with reschedule=false: the periodic schedule
// stays with the JobScheduler, which hands out the next window itself.
class BackgroundFetchJob : JobService() {
    private external fun pushWakeup()

    // Drawer "Use background connection" (Rust writes notify-prefs.json into
    // filesDir; missing file or key = on). OFF: this scheduled job is the
    // background connection — finish immediately without waking the core.
    private fun backgroundConnectionEnabled(): Boolean =
        try {
            val file = java.io.File(filesDir, "notify-prefs.json")
            if (file.exists()) {
                val obj = org.json.JSONObject(file.readText())
                if (obj.has("use_bg_connection")) obj.getBoolean("use_bg_connection") else true
            } else true
        } catch (_: Exception) { true }

    override fun onStartJob(params: JobParameters?): Boolean {
        if (!backgroundConnectionEnabled()) {
            Log.d(TAG, "scheduled fetch: skipped (background connection off)")
            jobFinished(params, false)
            return false
        }
        Log.d(TAG, "scheduled fetch: waking the core")
        try {
            pushWakeup()
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "native lib not loaded - core not running", e)
            jobFinished(params, false)
            return false
        }
        // The native side runs the fetch asynchronously; keep the job open
        // past its 30s bound so the process stays unfrozen while it works.
        Handler(Looper.getMainLooper()).postDelayed({ jobFinished(params, false) }, FETCH_GRACE_MS)
        return true
    }

    override fun onStopJob(params: JobParameters?): Boolean {
        return false
    }

    companion object {
        private const val TAG = "BackgroundFetchJob"
        private const val FETCH_GRACE_MS = 28_000L

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
