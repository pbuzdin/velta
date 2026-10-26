package org.velta

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject

// Scheduled messages ("Send later", docs/scheduled-messages.md). ONE alarm
// for the next due item, computed from scheduled.json in filesDir (written
// by scheduled.rs) so it can be re-armed at boot without the WebView or the
// native library. Exact (setExactAndAllowWhileIdle) when the user granted
// SCHEDULE_EXACT_ALARM, otherwise setAndAllowWhileIdle — Doze may then
// deliver it ~10-15 min late (maintenance windows).
object ScheduledAlarm {
    private const val TAG = "ScheduledAlarm"
    const val FILE = "scheduled.json"
    const val ACTION_FIRE = "org.velta.SCHEDULED_SEND"
    private const val CHANNEL_ID = "velta-scheduled"
    private const val NOTIFICATION_ID = 0x5C4D

    /** Mirrors nextWake() in app/js/scheduled.js / scheduled_store.rs. */
    @JvmStatic
    fun nextWake(json: String): Long? {
        val items = try { JSONObject(json).optJSONArray("items") } catch (_: Exception) { null } ?: return null
        var best: Long? = null
        for (i in 0 until items.length()) {
            val it = items.optJSONObject(i) ?: continue
            if (!it.has("dueAt")) continue
            val due = it.optLong("dueAt")
            val at = when (it.optString("status")) {
                "pending" -> due
                "error" -> if (it.optBoolean("uncertain", false)) null
                    else maxOf(due, if (it.isNull("retryAt")) due else it.optLong("retryAt", due))
                else -> null
            } ?: continue
            if (best == null || at < best) best = at
        }
        return best
    }

    private fun pending(context: Context): PendingIntent {
        val intent = Intent(context, ScheduledAlarmReceiver::class.java).setAction(ACTION_FIRE)
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    @JvmStatic
    fun canExact(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 31) return true
        val am = context.getSystemService(AlarmManager::class.java) ?: return false
        return am.canScheduleExactAlarms()
    }

    /** Opens the per-app "Alarms & reminders" settings page (Android 12+). */
    @JvmStatic
    fun requestExact(context: Context) {
        if (Build.VERSION.SDK_INT < 31) return
        val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try { context.startActivity(intent) } catch (e: Exception) { Log.w(TAG, "exact alarm settings: $e") }
    }

    @JvmStatic
    fun rearm(context: Context) {
        val am = context.getSystemService(AlarmManager::class.java) ?: return
        // Rust writes scheduled.json into Tauri's app-local dir (dataDir).
        val next = try { AppFiles.read(context, FILE)?.let { nextWake(it) } } catch (_: Exception) { null }
        val pi = pending(context)
        if (next == null) { am.cancel(pi); return }
        val at = maxOf(next, System.currentTimeMillis() + 1000)
        try {
            if (canExact(context)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        } catch (e: SecurityException) {
            // Permission revoked between the check and the call.
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        }
        Log.d(TAG, "armed for $at (exact=${canExact(context)})")
    }

    /** Cold process (no core): ask the user to open Velta. Tap = launcher intent. */
    @JvmStatic
    fun notifyOpenApp(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Scheduled messages", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val launch = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            .setClass(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        val pi = PendingIntent.getActivity(context, 1, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(context.applicationInfo.icon)
            .setContentTitle("Scheduled message is due")
            .setContentText("Open Velta to send it")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        try { nm.notify(NOTIFICATION_ID, n) } catch (_: SecurityException) { }
    }
}

// Alarm + re-registration triggers (boot, app update, clock/time-zone change).
class ScheduledAlarmReceiver : BroadcastReceiver() {
    companion object {
        // Under the 60 s background-broadcast limit; a cold core takes up to
        // 20 s to come up, then the sends.
        private const val SEND_MAX_SECS = 45
    }

    // scheduled.rs: sends the due items, blocking up to maxSecs; false when
    // no core runs in this process.
    private external fun scheduledRunBlocking(maxSecs: Int): Boolean

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ScheduledAlarm.ACTION_FIRE) {
            // BOOT_COMPLETED / MY_PACKAGE_REPLACED / TIME_SET / TIMEZONE_CHANGED /
            // exact-alarm permission granted: dueAt is UTC, just re-arm.
            ScheduledAlarm.rearm(context)
            // After boot or an update nothing else brings the background
            // connection back until the app is opened: start the service
            // (allowed from these broadcasts), which starts the core.
            if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
                if (BgPrefs.backgroundConnectionEnabled(context)) {
                    try { CoreService.start(context) } catch (e: Exception) { Log.w("ScheduledAlarm", "CoreService at boot: $e") }
                }
            }
            return
        }
        // Try the foreground service too (keeps the connection afterwards).
        // Allowed from an exact alarm; an inexact one is refused on Android
        // 12+ (ForegroundServiceStartNotAllowedException), which is why the
        // send itself does not depend on it: goAsync keeps this receiver,
        // and so the process, alive until the send finished.
        try { CoreService.start(context) } catch (e: Exception) { Log.w("ScheduledAlarm", "CoreService: $e") }
        // Cold process (killed since the alarm was armed): start the core
        // here so the send does not depend on the activity.
        VeltaCore.ensureStarted(context)
        val pending = goAsync()
        Thread({
            try {
                val taken = try { scheduledRunBlocking(SEND_MAX_SECS) } catch (_: UnsatisfiedLinkError) { false }
                if (!taken) ScheduledAlarm.notifyOpenApp(context)
                // The native run re-arms after each item; this covers "not taken".
                ScheduledAlarm.rearm(context)
            } finally {
                pending.finish()
            }
        }, "velta-scheduled-send").start()
    }
}
