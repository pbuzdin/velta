package org.velta.kmp.ui

import org.velta.kmp.core.Contact

/**
 * Read-only channel bar (2026-11-17 user design): a Delta Chat channel the
 * user has no post right for (core `canSend` = false) replaces the composer
 * with a bottom bar — search in chat, contact the channel author, mute or
 * unmute. The composer hiding itself is web parity (`chat-view.js` hides it
 * for read-only chats via the same `can_send` check); the bar is the KMP
 * addition. Owned channels (`OutBroadcast` with post rights) keep the
 * composer.
 */
object ChannelBarRules {

    fun isChannel(chatType: String?): Boolean =
        chatType == "InBroadcast" || chatType == "OutBroadcast"

    /** Optimistic at open from the list item's type (the web also opens a
     *  channel read-only), confirmed by the fullChat rights check. */
    fun showBar(chatType: String?, canSend: Boolean): Boolean =
        isChannel(chatType) && !canSend

    /** "Contact the author" only when the channel resolves exactly one
     *  contact — its author. Anything else: omit the button, never guess. */
    fun showAuthorButton(contactCount: Int): Boolean = contactCount == 1
}

/** Bar state for the open chat; `author` lands async (contact resolve). */
data class ChannelBarState(
    val muted: Boolean = false,
    val author: Contact? = null,
)
