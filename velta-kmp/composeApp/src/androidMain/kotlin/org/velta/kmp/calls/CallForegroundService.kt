package org.velta.kmp.calls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import org.velta.kmp.MainActivity

/**
 * Foreground service for an ACTIVE call (microphone type): keeps the mic
 * alive and the process priority up when the screen locks mid-call. Started
 * when a call connects, stopped when it ends — the sync service
 * (VeltaForegroundService, remoteMessaging type) stays a separate process.
 */
class CallForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    buildNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
                )
            } else {
                startForeground(NOTIFICATION_ID, buildNotification())
            }
        } catch (t: RuntimeException) {
            println("velta-kmp: call service start refused: $t")
            stopSelf(startId)
            return START_NOT_STICKY
        }
        return START_NOT_STICKY
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Calls", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentTitle("Velta")
            .setContentText("Ongoing call")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "velta-call"
        private const val NOTIFICATION_ID = 2

        fun start(context: Context) {
            try {
                context.startForegroundService(Intent(context, CallForegroundService::class.java))
            } catch (t: RuntimeException) {
                println("velta-kmp: call service start refused: $t")
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CallForegroundService::class.java))
        }
    }
}
