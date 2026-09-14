package org.velta

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

// Foreground service that keeps the Velta process alive while the activity
// is gone: the Delta Chat core is linked into this process, so as long as
// the service runs, IMAP/SMTP (and the Rust background event poller that
// posts incoming-message notifications) keep working in the background.
// remoteMessaging (not dataSync) avoids Android 15's 6-hour daily FGS cap.
class CoreService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Message sync", NotificationManager.IMPORTANCE_MIN)
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle("Velta")
            .setContentText("Keeping your messages up to date")
            .setOngoing(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        // STICKY: restart the (empty) service if the system kills it; the
        // core itself is re-initialized by the activity on next open.
        return START_STICKY
    }

    companion object {
        const val CHANNEL_ID = "velta-core"
        const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            androidx.core.content.ContextCompat.startForegroundService(context, Intent(context, CoreService::class.java))
        }
    }
}
