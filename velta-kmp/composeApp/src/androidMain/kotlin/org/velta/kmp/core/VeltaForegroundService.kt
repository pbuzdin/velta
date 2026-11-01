package org.velta.kmp.core

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import org.velta.kmp.AppHolder

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
        startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        // Rebuild the core after a process kill; a no-op when it is already up.
        AppHolder.obtain(applicationContext).connect()
        return START_STICKY
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Background sync",
                    NotificationManager.IMPORTANCE_MIN,
                ),
            )
        }
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Velta")
            .setContentText("Keeping your messages up to date")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "velta-sync"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            context.startForegroundService(Intent(context, VeltaForegroundService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, VeltaForegroundService::class.java))
        }
    }
}
