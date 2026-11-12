package org.velta.kmp.core

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import org.velta.kmp.MainActivity
import org.velta.kmp.ui.AppModel

/**
 * Conversation notifications: one "Messages" channel, one notification per
 * chat (id = chat id, so a new message replaces the chat's previous one),
 * tap deep-opens the chat through [MainActivity]'s `chatId` extra.
 */
class AndroidIncomingNotifier(private val context: Context) : AppModel.IncomingNotifier {

    companion object {
        const val CHANNEL_ID = "messages"
    }

    override fun notifyIncoming(chatId: Long, chatName: String, text: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "New messages in chats"
                },
            )
        }
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("chatId", chatId)
        }
        val pending = PendingIntent.getActivity(
            context,
            chatId.toInt(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(context.applicationInfo.icon)
            .setContentTitle(chatName)
            .setContentText(text)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        manager.notify(chatId.toInt(), notification)
    }
}
