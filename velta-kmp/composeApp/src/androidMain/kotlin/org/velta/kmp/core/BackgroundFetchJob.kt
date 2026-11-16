package org.velta.kmp.core

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.velta.kmp.AppHolder
import org.velta.kmp.ui.BackgroundPolicy
import java.util.concurrent.ConcurrentHashMap

/**
 * Periodic catch-up (#358 Background delivery, item 1) — a port of Velta
 * stable's BackgroundFetchJob (velta-app/src-tauri/gen/android/.../
 * BackgroundFetchJob.kt), the same pattern as Delta Chat Android's
 * FetchWorker: every 15 minutes (persisted, any network) the system wakes
 * the process — also on OEM ROMs that freeze a backgrounded app or with no
 * UnifiedPush distributor — and the shared model runs one bounded
 * `background_fetch` (AppModel.catchUpFetch). A killed process gets a
 * headless core: AppHolder builds the model without the activity.
 *
 * The job holds its slot until the fetch finished (not a fixed time), then
 * jobFinished(reschedule = false): the periodic schedule stays with the
 * JobScheduler. Stopped early by the system → the fetch is cancelled and a
 * retry is requested.
 */
class BackgroundFetchJob : JobService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val running = ConcurrentHashMap<Int, Job>()

    override fun onStartJob(params: JobParameters): Boolean {
        Log.d(TAG, "scheduled fetch: waking the core")
        val model = AppHolder.obtain(applicationContext)
        val key = params.jobId
        running[key] = scope.launch {
            val done = withTimeoutOrNull(BackgroundPolicy.JOB_MAX_MS) { model.catchUpFetch("scheduled") } ?: false
            Log.d(TAG, "scheduled fetch: finished (done=$done)")
            // onStopJob removed the entry: the system already took the slot back.
            if (running.remove(key) != null) jobFinished(params, false)
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        running.remove(params.jobId)?.cancel()
        Log.d(TAG, "scheduled fetch: stopped by the system, rescheduling")
        return true
    }

    companion object {
        private const val TAG = "BackgroundFetchJob"

        /** Idempotent: re-scheduling the same periodic job keeps it. */
        fun schedule(context: Context) {
            val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
            val info = JobInfo.Builder(BackgroundPolicy.JOB_ID, ComponentName(context, BackgroundFetchJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(BackgroundPolicy.PERIODIC_MS)
                .setPersisted(true) // needs RECEIVE_BOOT_COMPLETED
                .build()
            val result = try {
                scheduler.schedule(info)
            } catch (t: RuntimeException) {
                Log.e(TAG, "scheduled fetch job rejected", t)
                JobScheduler.RESULT_FAILURE
            }
            if (result == JobScheduler.RESULT_SUCCESS) {
                Log.d(TAG, "scheduled fetch job registered")
            } else {
                Log.e(TAG, "scheduled fetch job registration failed: $result")
            }
        }

        fun cancel(context: Context) {
            context.getSystemService(JobScheduler::class.java)?.cancel(BackgroundPolicy.JOB_ID)
        }
    }
}
