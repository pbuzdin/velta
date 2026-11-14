package org.velta.kmp.core

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import org.velta.kmp.MainActivity
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.L

/**
 * Conversation notifications: one "Messages" channel, one notification per
 * (account, chat) — the tag is [AppModel.notificationKey], so a new message
 * replaces that chat's previous one and chats of different accounts never
 * collide (#334). Tap deep-opens the chat through [MainActivity]'s
 * `accountId` + `chatId` extras.
 */
class AndroidIncomingNotifier(private val context: Context) : AppModel.IncomingNotifier {

    companion object {
        const val CHANNEL_ID = "messages"

        /** All message notifications share this id; the TAG makes them unique
         * (the sync service's ongoing notification uses id 1, no tag). */
        private const val NOTIFICATION_ID = 1000
    }

    private val manager: NotificationManager
        get() = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    override fun notifyIncoming(accountId: Long, chatId: Long, chatName: String, text: String) {
        val manager = manager
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, L.t("Messages"), NotificationManager.IMPORTANCE_HIGH),
            )
        }
        val key = AppModel.notificationKey(accountId, chatId)
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("accountId", accountId)
            putExtra("chatId", chatId)
        }
        val pending = PendingIntent.getActivity(
            context,
            key.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(chatName)
            .setContentText(text)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        manager.notify(key, NOTIFICATION_ID, notification)
    }

    override fun cancel(accountId: Long, chatId: Long) {
        manager.cancel(AppModel.notificationKey(accountId, chatId), NOTIFICATION_ID)
    }
}
