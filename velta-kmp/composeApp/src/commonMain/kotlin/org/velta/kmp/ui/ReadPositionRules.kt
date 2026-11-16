package org.velta.kmp.ui

/**
 * Read position (#358 B) — a pure port of stable chat-view.js:
 *  - `open()`: a chat with unread messages opens at the first unread one
 *    (core `get_first_unread_message_of_chat`), a fully read chat at the
 *    bottom; the "Unread messages" line sits above that message, fixed
 *    for the visit,
 *  - `_checkSeen` / `_markSeenThrough`: seen is a watermark — the lowest
 *    row that counts as seen marks every loaded unread message up to it,
 *  - `_nearBottom` / `_renderGoDown`: the go-down button shows while the
 *    view is away from the newest message, its badge counts the unread
 *    messages below ("999+" cap); a tap catches up (marknoticed_chat, no
 *    read receipts for the skipped rows) and jumps to the newest message.
 * Stable's manual read-up-to-here marker has had no way to be set since
 * 7fb50b17 (#38 removed the menu item), so it is not ported.
 * No Compose here: ReadPositionRulesTest pins every rule.
 */

/** Where a freshly opened chat lands. */
sealed interface OpenScroll {
    data object Bottom : OpenScroll
    /** The first unread message (the "Unread messages" line above it). */
    data class Unread(val msgId: Long) : OpenScroll
}

/** Stable open(): only a chat with unread messages asks the core for the
 *  first unread one; a null answer opens at the bottom. */
fun openScrollFor(unread: Int, firstUnreadId: Long?): OpenScroll =
    if (unread > 0 && firstUnreadId != null && firstUnreadId > 0L) OpenScroll.Unread(firstUnreadId) else OpenScroll.Bottom

/** Messages kept above the anchor (stable `getMessages({ aroundId, before: 10 })`). */
const val OPEN_CONTEXT_ABOVE = 10

/**
 * Window start for an open: the newest [pageSize] ids, widened back so the
 * first unread message and [OPEN_CONTEXT_ABOVE] above it are loaded. An
 * anchor further back than [JUMP_MAX_MESSAGES] from the newest keeps the
 * window at that cap (KMP pages only upwards — there is no "load newer").
 */
fun openWindowFrom(ids: List<Long>, pageSize: Int, anchorId: Long?): Int {
    val tail = (ids.size - pageSize).coerceAtLeast(0)
    val idx = anchorId?.let { ids.indexOf(it) } ?: -1
    if (idx < 0 || idx >= tail + OPEN_CONTEXT_ABOVE) return tail
    val cap = (ids.size - JUMP_MAX_MESSAGES).coerceAtLeast(0)
    return (idx - OPEN_CONTEXT_ABOVE).coerceAtLeast(cap).coerceAtLeast(0).coerceAtMost(tail)
}

/** The "Unread messages" line: the core's first unread, else the first
 *  loaded unread message (stable `firstUnread ?? messages.find(m => m.unread)`). */
fun unreadLineId(coreFirstUnread: Long?, loadedUnreadIds: List<Long>): Long? =
    coreFirstUnread ?: loadedUnreadIds.firstOrNull()

/**
 * Stable `_checkSeen` row test, in px relative to the viewport: a row that
 * intersects the viewport counts as seen when it is fully on screen (2 px
 * slack) or its top is within the upper half (a tall row).
 */
fun rowCountsAsSeen(top: Int, bottom: Int, viewTop: Int, viewBottom: Int): Boolean {
    if (bottom <= top || top >= viewBottom || bottom <= viewTop) return false
    return bottom <= viewBottom + 2 || top <= viewTop + (viewBottom - viewTop) / 2
}

/** Stable `_markSeenThrough`: every loaded id up to and including the
 *  watermark, oldest first; nothing when there is no watermark. */
fun seenThrough(orderedIds: List<Long>, watermarkId: Long?): List<Long> {
    watermarkId ?: return emptyList()
    val idx = orderedIds.indexOf(watermarkId)
    return if (idx < 0) emptyList() else orderedIds.subList(0, idx + 1)
}

/** Stable `_nearBottom`: under 220 px of history below the viewport. */
const val NEAR_BOTTOM_PX = 220

/** [lastVisibleIndex] / [rowCount] are list rows; [pxBelow] is how far the
 *  last visible row reaches past the viewport end (≤ 0 = fully shown). */
fun nearBottom(lastVisibleIndex: Int, rowCount: Int, pxBelow: Int, thresholdPx: Int = NEAR_BOTTOM_PX): Boolean =
    rowCount == 0 || (lastVisibleIndex >= rowCount - 1 && pxBelow < thresholdPx)

/** Stable `_renderGoDown` badge text: hidden at 0, "999+" above 999. */
fun goDownBadge(count: Int): String? = when {
    count <= 0 -> null
    count > 999 -> "999+"
    else -> count.toString()
}
