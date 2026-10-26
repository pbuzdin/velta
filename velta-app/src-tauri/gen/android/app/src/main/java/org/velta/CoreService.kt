package org.velta

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat

// Foreground service that keeps the Velta process alive while the activity
// is gone: the Delta Chat core is linked into this process, so as long as
// the service runs, IMAP/SMTP (and the Rust background event poller that
// posts incoming-message notifications) keep working in the background.
// remoteMessaging (not dataSync) avoids Android 15's 6-hour daily FGS cap.
class CoreService : Service() {
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    // Instance JNI (lib.rs). VeltaApp loads velta_app.so in every process;
    // callers still catch UnsatisfiedLinkError in case that failed.
    private external fun networkAvailable(available: Boolean)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.bg_channel_name), NotificationManager.IMPORTANCE_MIN)
        )
        // No wake lock: a permanent PARTIAL_WAKE_LOCK kept the CPU awake all
        // day (Play vitals "excessive wake locks") and Doze ignores it anyway.
        // An IMAP IDLE socket wakes the CPU when data arrives, like upstream
        // Delta Chat's KeepAliveService; the battery exemption covers Doze.
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

    // Tapping the persistent notification opens Velta (#82). Same intent the
    // launcher fires: MAIN/LAUNCHER aimed at MainActivity, which is
    // singleTask, so a running task is brought to the front (onNewIntent)
    // instead of a second instance being created, and a dead activity is
    // started fresh. No data URI and no extras on purpose: the velta://chat
    // deep-link path of the message notifications (#20, Notifications.kt)
    // only reacts to VIEW data, so this tap just opens the app where it was.
    private fun openAppIntent(): PendingIntent {
        val launch = Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setClass(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        return PendingIntent.getActivity(
            this,
            0,
            launch,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun buildNotification(syncing: Boolean) =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle("Velta")
            .setContentText(getString(if (syncing) R.string.bg_syncing else R.string.bg_not_syncing))
            .setContentIntent(openAppIntent())
            .setOngoing(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // A sticky restart after the process died has no activity: start the
        // core here so the service really syncs (audit item 1). With the UI
        // up this reuses the core Tauri setup created.
        val starting = VeltaCore.ensureStarted(this)
        val notification = buildNotification(starting)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        // Never claim to sync while no core runs: re-check once init had
        // time to finish (Accounts::new on a cold start).
        if (starting) {
            Handler(Looper.getMainLooper()).postDelayed({ refreshNotification() }, CORE_CHECK_MS)
        }
        // STICKY: the system restarts the service after a kill, and the
        // restart starts the core again (above).
        return START_STICKY
    }

    private fun refreshNotification() {
        if (VeltaCore.running()) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        try {
            manager.notify(NOTIFICATION_ID, buildNotification(false))
        } catch (_: SecurityException) {
        }
    }

    companion object {
        const val CHANNEL_ID = "velta-core"
        const val NOTIFICATION_ID = 1
        private const val CORE_CHECK_MS = 30_000L

        fun start(context: Context) {
            androidx.core.content.ContextCompat.startForegroundService(context, Intent(context, CoreService::class.java))
        }
    }
}
