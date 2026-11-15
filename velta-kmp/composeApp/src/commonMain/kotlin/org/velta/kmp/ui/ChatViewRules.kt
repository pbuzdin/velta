package org.velta.kmp.ui

/**
 * Pure chat-view rules (#334 step 8), mirrored from stable
 * app/css/main.css and app/js/chat-view.js. No Compose here so the
 * desktop tests pin them.
 */

/** Stable `.bubble { max-width: min(480px, 90%) }` on a full-width
 *  `.msg-row` (`.out` = justify-content: flex-end, so outgoing bubbles
 *  touch the right edge); `.with-avatar` reserves the 42px avatar + 8px
 *  gap: `min(480px, calc(90% - 50px))`. [rowWidth] in dp. */
fun bubbleMaxWidth(rowWidth: Float, withAvatar: Boolean): Float =
    minOf(480f, rowWidth * 0.9f - if (withAvatar) 50f else 0f).coerceAtLeast(0f)

/** chat-view.js leaving a chat: `if (input.value || this.replyTo)` keeps
 *  the draft; KMP drafts also carry a staged attachment. */
fun keepDraft(text: String, hasAttachment: Boolean, quoteId: Long?): Boolean =
    text.isNotEmpty() || hasAttachment || quoteId != null
