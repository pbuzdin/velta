package org.velta

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

// Foreground service that keeps the Velta process alive while the activity
// is gone: the Delta Chat core is linked into this process, so as long as
// the service runs, IMAP/SMTP (and the Rust background event poller that
// posts incoming-message notifications) keep working in the background.
// remoteMessaging (not dataSync) avoids Android 15's 6-hour daily FGS cap.
class CoreService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    // Instance JNI (lib.rs). A sticky restart can come up before the activity
    // has loaded velta_app.so; callers catch UnsatisfiedLinkError.
    private external fun networkAvailable(available: Boolean)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Message sync", NotificationManager.IMPORTANCE_MIN)
        )
        // Screen-off would otherwise freeze every thread in this process,
        // including the IMAP IDLE loop, while this notification stays up.
        // Doze still ignores wake locks; the battery exemption covers that.
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "velta:core").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {
        }
        registerNetworkCallback()
    }

    override fun onDestroy() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        networkCallback?.let { cb ->
            try {
                cm?.unregisterNetworkCallback(cb)
            } catch (_: Exception) {
            }
        }
        networkCallback = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    private fun registerNetworkCallback() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = notify(true)
            override fun onLost(network: Network) = notify(false)
            private fun notify(available: Boolean) {
                try {
                    networkAvailable(available)
                } catch (_: UnsatisfiedLinkError) {
                }
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            networkCallback = cb
        } catch (_: Exception) {
        }
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
