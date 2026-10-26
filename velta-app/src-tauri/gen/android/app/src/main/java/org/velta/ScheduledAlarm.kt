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
import java.io.File

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
        val file = File(context.filesDir, FILE)
        val next = try { if (file.exists()) nextWake(file.readText()) else null } catch (_: Exception) { null }
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
    // scheduled.rs: true when the in-process core took the job.
    private external fun scheduledWakeup(): Boolean

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ScheduledAlarm.ACTION_FIRE) {
            // BOOT_COMPLETED / MY_PACKAGE_REPLACED / TIME_SET / TIMEZONE_CHANGED /
            // exact-alarm permission granted: dueAt is UTC, just re-arm.
            ScheduledAlarm.rearm(context)
            return
        }
        // Keep the process (and its core) up for the send: same foreground
        // service the app already runs. Allowed from an exact alarm; an
        // inexact one may be refused on Android 12+ — the send still runs
        // if the core is up.
        try { CoreService.start(context) } catch (e: Exception) { Log.w("ScheduledAlarm", "CoreService: $e") }
        val taken = try { scheduledWakeup() } catch (_: UnsatisfiedLinkError) { false }
        if (!taken) ScheduledAlarm.notifyOpenApp(context)
        // The native run re-arms after each item; this covers "not taken".
        ScheduledAlarm.rearm(context)
    }
}
