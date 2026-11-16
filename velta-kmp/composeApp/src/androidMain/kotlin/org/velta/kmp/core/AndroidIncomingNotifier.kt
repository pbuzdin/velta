package org.velta.kmp.core

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat
import org.velta.kmp.ui.IncomingNotice
import java.util.concurrent.ConcurrentHashMap
import org.velta.kmp.MainActivity
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.L

/**
 * Conversation notifications: one "Messages" channel, one notification per
 * (account, chat) — the tag is [AppModel.notificationKey], so a new message
 * replaces that chat's previous one and chats of different accounts never
 * collide (#334). Tap deep-opens the chat through [MainActivity]'s
 * `accountId` + `chatId` extras.
 *
 * [notifyMessage] posts a MessagingStyle conversation (stable
 * Notifications.kt, the official Delta Chat look): group name as the
 * conversation title, the sender as the message's person with their avatar,
 * plain text, the chat avatar as large icon; consecutive messages of one chat
 * append to the same notification until it is read or cleared.
 */
class AndroidIncomingNotifier(private val context: Context) : AppModel.IncomingNotifier {

    companion object {
        const val CHANNEL_ID = "messages"

        /** All message notifications share this id; the TAG makes them unique
         * (the sync service's ongoing notification uses id 1, no tag). */
        private const val NOTIFICATION_ID = 1000

        /** Messages kept per conversation notification. */
        private const val MAX_MESSAGES = 7
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

    /** Live conversation per chat key, so follow-ups append. */
    private val styles = ConcurrentHashMap<String, NotificationCompat.MessagingStyle>()

    override fun notifyMessage(notice: IncomingNotice) {
        val manager = manager
        ensureChannel(manager)
        val key = AppModel.notificationKey(notice.accountId, notice.chatId)
        val sender = Person.Builder()
            .setName(notice.senderName)
            .setKey("${notice.accountId}:${notice.senderName}")
            .apply { decode(notice.senderAvatar)?.let { setIcon(IconCompat.createWithBitmap(it)) } }
            .build()
        // Swiped away or tapped since: start a fresh conversation.
        val showing = try {
            manager.activeNotifications.any { it.tag == key && it.id == NOTIFICATION_ID }
        } catch (_: RuntimeException) {
            true
        }
        if (!showing) styles.remove(key)
        val style = styles.getOrPut(key) {
            NotificationCompat.MessagingStyle(Person.Builder().setName(L.t("You")).build())
        }
        style.setGroupConversation(notice.isGroup)
        style.conversationTitle = if (notice.isGroup) notice.chatName else null
        style.addMessage(notice.text, notice.timestampMs, sender)
        // Keep the conversation bounded (the system shows the last few).
        while (style.messages.size > MAX_MESSAGES) style.messages.removeAt(0)
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setStyle(style)
            .setContentIntent(openChat(notice.accountId, notice.chatId, key))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setWhen(notice.timestampMs)
            .setShowWhen(true)
        decode(notice.chatAvatar)?.let { builder.setLargeIcon(it) }
        manager.notify(key, NOTIFICATION_ID, builder.build())
    }

    override fun cancel(accountId: Long, chatId: Long) {
        val key = AppModel.notificationKey(accountId, chatId)
        styles.remove(key)
        manager.cancel(key, NOTIFICATION_ID)
    }

    private fun ensureChannel(manager: NotificationManager) {
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, L.t("Messages"), NotificationManager.IMPORTANCE_HIGH),
            )
        }
    }

    private fun openChat(accountId: Long, chatId: Long, key: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("accountId", accountId)
            putExtra("chatId", chatId)
        }
        return PendingIntent.getActivity(context, key.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun decode(path: String?): android.graphics.Bitmap? {
        if (path.isNullOrEmpty()) return null
        return try {
            BitmapFactory.decodeFile(path)
        } catch (_: Throwable) {
            null
        }
    }
}
