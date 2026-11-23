package org.velta

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.text.format.Formatter
import androidx.core.app.NotificationCompat

/**
 * #454: keeps the process alive while long Local chat (Loop) transfers run,
 * with one progress notification for all of them and a Cancel action.
 * Driven from Rust (saf.rs run_tracker): update(count, got, size) about
 * once a second, count 0 when the last transfer ended.
 */
class LoopTransferService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_CANCEL) {
      try {
        cancelAll()
      } catch (_: UnsatisfiedLinkError) {
      }
      // Rust stops the service once the cancelled transfers report back.
      return START_NOT_STICKY
    }
    val n = build(this)
    try {
      if (Build.VERSION.SDK_INT >= 34) {
        startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(NOTIFICATION_ID, n)
      }
      running = true
    } catch (_: Exception) {
      stopSelf()
    }
    // A killed process has no transfers to come back to.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL_ID = "velta-loop-transfer"
    private const val NOTIFICATION_ID = 5
    private const val ACTION_CANCEL = "org.velta.LOOP_CANCEL"

    @Volatile private var running = false
    @Volatile private var count = 0
    @Volatile private var got = 0L
    @Volatile private var size = 0L

    @JvmStatic external fun cancelAll()

    @JvmStatic
    fun update(context: Context, count: Int, got: Long, size: Long) {
      this.count = count
      this.got = got
      this.size = size
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
      if (count <= 0) {
        context.stopService(Intent(context, LoopTransferService::class.java))
        running = false
        manager.cancel(NOTIFICATION_ID)
        return
      }
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, context.getString(R.string.loop_transfer_channel), NotificationManager.IMPORTANCE_LOW)
      )
      if (running) {
        try {
          manager.notify(NOTIFICATION_ID, build(context))
        } catch (_: SecurityException) {
        }
        return
      }
      try {
        androidx.core.content.ContextCompat.startForegroundService(context, Intent(context, LoopTransferService::class.java))
      } catch (_: Exception) {
        // Started from the background (Android 12+ refuses): show the
        // progress anyway; the transfer runs while the process lives.
        try {
          manager.notify(NOTIFICATION_ID, build(context))
        } catch (_: SecurityException) {
        }
      }
    }

    private fun build(context: Context): android.app.Notification {
      val cancel = PendingIntent.getService(
        context,
        5,
        Intent(context, LoopTransferService::class.java).setAction(ACTION_CANCEL),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val open = launch?.let {
        PendingIntent.getActivity(context, 6, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      val permille = if (size > 0) ((got * 1000) / size).toInt().coerceIn(0, 1000) else 0
      val title = context.resources.getQuantityString(R.plurals.loop_transfer_title, count, count)
      val text = context.getString(
        R.string.loop_transfer_progress,
        Formatter.formatShortFileSize(context, got),
        Formatter.formatShortFileSize(context, size),
      )
      val b = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle(title)
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setProgress(1000, permille, size <= 0)
        .addAction(0, context.getString(R.string.loop_transfer_cancel), cancel)
      if (open != null) b.setContentIntent(open)
      return b.build()
    }
  }
}
