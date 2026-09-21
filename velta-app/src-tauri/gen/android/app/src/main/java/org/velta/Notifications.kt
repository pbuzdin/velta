package org.velta

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.NotificationCompat.MessagingStyle
import androidx.core.graphics.drawable.IconCompat
import java.util.concurrent.ConcurrentHashMap

// Incoming-message notifications with the official Delta Chat look:
// MessagingStyle conversations (group name as title, sender name as the
// second line, plain message text below — never a "Group: text" prefix),
// the sender's avatar in the left slot via the messaging Person, and the
// chat avatar as largeIcon on the right. Consecutive messages for the same
// chat append to one conversation notification instead of stacking cards.
//
// Called from Rust (bg_notify_incoming) over JNI, like InAppBrowser.open.
object Notifications {
    private const val CHANNEL_ID = "velta-messages"
    private const val BASE_NOTIFICATION_ID = 20000

    // Live conversation state per chat ("account:chatId") so follow-up
    // messages append to the existing notification instead of resetting it.
    private val styles = ConcurrentHashMap<String, MessagingStyle>()

    @JvmStatic
    fun show(
        context: Context,
        chatKey: String,
        isGroup: Boolean,
        chatName: String,
        chatAvatarPath: String?,
        senderName: String,
        senderAvatarPath: String?,
        text: String,
        timestampMs: Long,
    ) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH)
            )
        }

        val senderBitmap = decode(senderAvatarPath)
        val senderBuilder = Person.Builder().setName(senderName)
        if (senderBitmap != null) senderBuilder.setIcon(IconCompat.createWithBitmap(senderBitmap))
        val sender = senderBuilder.build()

        val existing = styles[chatKey]
        val style: MessagingStyle
        if (existing != null) {
            style = existing
        } else {
            style = MessagingStyle(sender)
            if (isGroup) style.setConversationTitle(chatName)
            style.setGroupConversation(isGroup)
        }
        style.addMessage(text, timestampMs, sender)

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(context.applicationInfo.icon)
            .setStyle(style)
            .setAutoCancel(true)
        val chatBitmap = decode(chatAvatarPath)
        if (chatBitmap != null) builder.setLargeIcon(chatBitmap)
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            builder.setContentIntent(
                android.app.PendingIntent.getActivity(
                    context,
                    chatKey.hashCode(),
                    launch,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
                )
            )
        }

        manager.notify(BASE_NOTIFICATION_ID + stableId(chatKey), builder.build())
        styles[chatKey] = style
    }

    /** Drop conversation state (called when notifications are cleared). */
    @JvmStatic
    fun clear(chatKey: String) {
        styles.remove(chatKey)
    }

    private fun stableId(key: String): Int = (key.hashCode() and 0x7fffffff) % 100000

    private fun decode(path: String?): android.graphics.Bitmap? {
        if (path.isNullOrEmpty()) return null
        return try {
            BitmapFactory.decodeFile(path)
        } catch (_: Throwable) {
            null
        }
    }
}
