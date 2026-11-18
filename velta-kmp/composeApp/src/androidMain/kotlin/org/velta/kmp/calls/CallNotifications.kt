package org.velta.kmp.calls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.app.NotificationCompat
import org.velta.kmp.AppHolder
import org.velta.kmp.MainActivity
import org.velta.kmp.ui.L

/**
 * Incoming-call notification (P2 follow-up): full-screen intent + decline
 * action, so a locked or backgrounded user sees the ring and can act
 * without unlocking. The ring overlay itself is state-driven in the app —
 * the full-screen intent opens it, and if the ring ended meanwhile the
 * overlay simply isn't shown.
 */
object CallNotifications {

    private const val CHANNEL_ID = "velta-call-ring"
    private const val NOTIFICATION_ID = 3
    const val ACTION_DECLINE = "org.velta.kmp.calls.DECLINE"

    private var declineReceiver: BroadcastReceiver? = null

    fun register(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Incoming calls",
                NotificationManager.IMPORTANCE_HIGH,
            )
            manager.createNotificationChannel(channel)
        }
        if (declineReceiver != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(receiverContext: Context, intent: Intent) {
                if (intent.action == ACTION_DECLINE) {
                    // Process-wide model: the same engine the ring overlay drives.
                    AppHolder.obtain(receiverContext.applicationContext).declineCall()
                    cancel(receiverContext)
                }
            }
        }
        declineReceiver = receiver
        // EXPORTED: the notification's PendingIntent broadcasts implicitly.
        context.registerReceiver(receiver, IntentFilter(ACTION_DECLINE), Context.RECEIVER_EXPORTED)
    }

    fun showIncoming(context: Context, name: String) {
        register(context)
        val manager = context.getSystemService(NotificationManager::class.java)
        val fullScreen = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val decline = PendingIntent.getBroadcast(
            context, 0,
            Intent(ACTION_DECLINE),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentTitle("Velta")
            .setContentText(name)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(fullScreen, true)
            .addAction(0, org.velta.kmp.ui.L.t("Decline"), decline)
            .setAutoCancel(true)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
    }

    fun cancel(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    }
}
