package org.velta.kmp.core

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import org.velta.kmp.AppHolder
import org.velta.kmp.MainActivity
import org.velta.kmp.appIconSmallIconRes
import org.velta.kmp.appLauncherTileBitmap
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat
import org.velta.kmp.currentAppIcon
import org.velta.kmp.ui.L
import org.velta.kmp.ui.syncServiceRuns

/**
 * Foreground service that keeps the app process — and with it the in-process
 * core shim — alive while the screen is off (P4 slice 6/7).
 *
 * On every start (including the sticky restart after the system killed the
 * process) it bootstraps the shared AppModel via [AppHolder]: the shim
 * respawns, the client reconnects and the event loop resumes — full sync
 * without the UI. The service itself holds the process; the model does the
 * work. Started when the activity stops, stopped when it resumes.
 */
class VeltaForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // remoteMessaging, like stable's CoreService: dataSync is capped at
        // 6 h per day on Android 15 (onTimeout, then a crash if ignored) —
        // a messenger's always-on IMAP IDLE is exactly remote messaging.
        try {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } catch (t: RuntimeException) {
            // Android 12+: ForegroundServiceStartNotAllowedException (e.g. a
            // sticky restart from the background). Don't crash the app.
            println("velta-kmp: foreground start refused: $t")
            stopSelf(startId)
            return START_NOT_STICKY
        }
        val model = AppHolder.obtain(applicationContext)
        // App lock on and no core (a sticky restart or boot after a kill):
        // there is no key without the user, so never claim to sync. Stable's
        // CoreService likewise only keeps running with a live core.
        // "Use background connection" off: no persistent notification, no
        // background core (stable CoreService: startForeground, then go away).
        val locked = org.velta.kmp.AndroidCorePlatform(applicationContext).isAppLocked()
        if (!syncServiceRuns(model.backgroundConnection, locked, model.connected)) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf(startId)
            return START_NOT_STICKY
        }
        // Rebuild the core after a process kill; a no-op when it is already up.
        model.connect()
        return START_STICKY
    }

    /** Android 15 time-limited types end here; stop cleanly instead of the
     * system's crash. remoteMessaging has no limit, so this is a guard. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        println("velta-kmp: foreground service timeout (type $fgsType)")
        stopSelf(startId)
    }

    override fun onDestroy() {
        // Do NOT tear the core down here: onDestroy fires on every return to
        // the foreground (MainActivity.onStart stops this service — battery
        // pattern), not only on app exit, and the UI is about to talk to the
        // core again. The shim dies with the process; AppModel.shutdownCore
        // stays available for EXPLICIT teardown only.
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    L.t("Background sync"),
                    NotificationManager.IMPORTANCE_MIN,
                ),
            )
        }
        // vivo's shell ALWAYS paints the cached app icon beside standard
        // and custom-content cards (two icons; the shell one stale after
        // alias switches). Conversation-style cards get exactly ONE icon —
        // the Person avatar — so the banner poses as one: avatar = the
        // chosen logo's tile, re-read from prefs on every service start.
        // Standard template (native placement, no fake chat): the only hook
        // that can put OUR tile on it is a Person — skins that render Person
        // icons on plain notifications show the chosen logo; skins that
        // ignore it fall back to their cached app icon.
        val tile = applicationContext.appLauncherTileBitmap(applicationContext.currentAppIcon())
        val velta = Person.Builder()
            .setName("Velta")
            .setIcon(IconCompat.createWithBitmap(tile))
            .build()
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(applicationContext.appIconSmallIconRes(applicationContext.currentAppIcon()))
            .setExtras(
                // NotificationCompat.Builder.setPerson needs a newer core;
                // the framework extra is the same hook (EXTRA_PERSON, API 28+,
                // harmlessly ignored below).
                android.os.Bundle().apply {
                    putParcelable(android.app.Notification.EXTRA_PERSON, velta.toAndroidPerson())
                },
            )
            .setContentTitle("Velta")
            .setContentText(L.t("Keeping your messages up to date"))
            .setContentIntent(openAppIntent())
            .setOngoing(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .build()
    }

    /** Tapping the ongoing notification opens Velta (stable CoreService
     *  openAppIntent, #82): the launcher's MAIN/LAUNCHER intent aimed at the
     *  singleTask MainActivity, so a running task comes to the front and a
     *  dead one starts fresh. No extras: it opens the app where it was. */
    private fun openAppIntent(): PendingIntent {
        val launch = Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setClass(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        return PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    companion object {
        private const val CHANNEL_ID = "velta-sync"
        private const val NOTIFICATION_ID = 1

        private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
        private var pendingStop: Runnable? = null

        /** A stop right after a start can land before the service is even
         *  created, and the system then throws
         *  ForegroundServiceDidNotStartInTimeException — the start contract
         *  stays violated even though the app asked to stop (seen on quick
         *  background/foreground cycles: permission dialog, app switch).
         *  Deferring the stop lets every start reach startForeground first;
         *  a fresh start cancels the pending stop, so nothing flashes. */
        private const val STOP_DELAY_MS = 400L

        fun start(context: Context) {
            pendingStop?.let { mainHandler.removeCallbacks(it) }
            pendingStop = null
            try {
                context.startForegroundService(Intent(context, VeltaForegroundService::class.java))
            } catch (t: RuntimeException) {
                // Background-start restrictions (Android 12+): sync then
                // resumes when the app is next opened.
                println("velta-kmp: foreground service start refused: $t")
            }
        }

        fun stop(context: Context) {
            pendingStop?.let { mainHandler.removeCallbacks(it) }
            val run = Runnable {
                pendingStop = null
                context.stopService(Intent(context, VeltaForegroundService::class.java))
            }
            pendingStop = run
            mainHandler.postDelayed(run, STOP_DELAY_MS)
        }
    }
}
