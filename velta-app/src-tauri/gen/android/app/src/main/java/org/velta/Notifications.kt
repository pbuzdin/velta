package org.velta

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
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
    private const val CHANNEL_ID_QUIET = "velta-messages-quiet"
    private const val BASE_NOTIFICATION_ID = 20000

    // Live conversation state per chat ("account:chatId") so follow-up
    // messages append to the existing notification instead of resetting it.
    private val styles = ConcurrentHashMap<String, MessagingStyle>()

    // Drawer notification prefs, written by Rust (set_notify_prefs) into the
    // app files dir as JSON; missing file or keys = defaults (all on).
    private fun pref(context: Context, key: String, default: Boolean): Boolean =
        try {
            val file = java.io.File(context.filesDir, "notify-prefs.json")
            if (file.exists()) {
                val obj = org.json.JSONObject(file.readText())
                if (obj.has(key)) obj.getBoolean(key) else default
            } else default
        } catch (_: Exception) { default }

    // Vibration/sound live on the CHANNEL: Android freezes most channel
    // settings after creation, so prefs pick the channel id — flipping a
    // switch lands in a fresh channel whose settings apply immediately.
    private fun channelFor(context: Context): String {
        val vibration = pref(context, "vibration", true)
        val sound = pref(context, "in_chat_sounds", true)
        val id = if (vibration && sound) CHANNEL_ID else CHANNEL_ID_QUIET
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(id, "Messages", NotificationManager.IMPORTANCE_HIGH)
            if (!sound) channel.setSound(null, null)
            if (!vibration) channel.enableVibration(false)
            manager.createNotificationChannel(channel)
        }
        return id
    }

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
        chatLinkToken: String,
    ) {
        val channelId = channelFor(context)
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

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

        val builder = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(context.applicationInfo.icon)
            .setStyle(style)
            .setAutoCancel(true)
        val chatBitmap = decode(chatAvatarPath)
        if (chatBitmap != null) builder.setLargeIcon(chatBitmap)
        // Tap opens the chat (issue #20): an explicit VIEW intent carrying
        // velta://chat?account=<id>&chat=<id>&t=<token>. The runtime (tao)
        // turns VIEW data into RunEvent::Opened on both cold start (onCreate)
        // and warm start (singleTask -> onNewIntent); lib.rs forwards it to
        // the WebView's existing deep-link path, which checks the token,
        // selects the account, and opens the chat.
        val open = Intent(Intent.ACTION_VIEW, Uri.parse(chatLink(chatKey, chatLinkToken)))
            .setClass(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        builder.setContentIntent(
            android.app.PendingIntent.getActivity(
                context,
                chatKey.hashCode(),
                open,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
            )
        )

        manager.notify(BASE_NOTIFICATION_ID + stableId(chatKey), builder.build())
        styles[chatKey] = style
    }

    /** Drop conversation state (called when notifications are cleared). */
    @JvmStatic
    fun clear(chatKey: String) {
        styles.remove(chatKey)
    }

    // chatKey is "account:chatId" (kotlin_notify_incoming in lib.rs).
    // The token is the shell's chat-link-token; the page rejects a tap
    // without it (issue #23).
    private fun chatLink(chatKey: String, token: String): String =
        "velta://chat?account=${chatKey.substringBefore(':')}&chat=${chatKey.substringAfter(':')}&t=${Uri.encode(token)}"

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
