package org.velta.kmp.core

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder

/**
 * Foreground service that keeps the app process — and with it the in-process
 * core shim — alive while the screen is off (P4 slice 6).
 *
 * The service itself does no work: the shim serves IMAP IDLE on its loopback
 * socket and the client's event loop lives at process scope, so holding the
 * process IS the job. Started when the activity stops, stopped when it
 * resumes. Restart-on-kill (core re-init in the service) is the next slice.
 */
class VeltaForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
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
