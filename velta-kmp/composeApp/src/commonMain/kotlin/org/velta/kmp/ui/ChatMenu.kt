package org.velta.kmp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties

/**
 * Chat menus (#334 step 5): stable's `.ctx-menu` popup (ui.js
 * showContextMenu + placeMenu) for the chat-list long-press / right-click
 * menu and the open chat's ⋮ menu, plus their confirmModal dialogs and the
 * group invite (ui.js showInvite). Rules live in ChatMenuRules.kt.
 */

/** Stable labels → L.t literals (tools/gen-kmp-strings.mjs reads literals). */
internal fun chatMenuLabel(label: String): String = when (label) {
    "Unpin" -> L.t("Unpin")
    "Pin to top" -> L.t("Pin to top")
    "Unmute" -> L.t("Unmute")
    "Mute notifications" -> L.t("Mute notifications")
    "Mark as read" -> L.t("Mark as read")
    "Delete old messages…" -> L.t("Delete old messages…")
    "Unarchive" -> L.t("Unarchive")
    "Archive" -> L.t("Archive")
    "Delete chat" -> L.t("Delete chat")
    "Chat info" -> L.t("Chat info")
    "Group invite QR" -> L.t("Group invite QR")
    "Mute" -> L.t("Mute")
    "Pin" -> L.t("Pin")
    "Leave channel" -> L.t("Leave channel")
    "Leave group" -> L.t("Leave group")
    "Clear history" -> L.t("Clear history")
    "Delete old messages" -> L.t("Delete old messages")
    "Delete" -> L.t("Delete")
    "Leave and delete" -> L.t("Leave and delete")
    "Leave" -> L.t("Leave")
    "Leave \"{name}\" and delete it with all its messages?" -> L.t("Leave \"{name}\" and delete it with all its messages?")
    "Delete \"{name}\" and all its messages?" -> L.t("Delete \"{name}\" and all its messages?")
    "You will no longer receive messages from this channel. Re-subscribe via its invite link/QR." ->
        L.t("You will no longer receive messages from this channel. Re-subscribe via its invite link/QR.")
    "You will leave this chat and no longer receive its messages." -> L.t("You will leave this chat and no longer receive its messages.")
    "Delete all messages in this chat?" -> L.t("Delete all messages in this chat?")
    "Delete every message in \"{name}\" older than {label}? Pinned messages are kept. This cannot be undone." ->
        L.t("Delete every message in \"{name}\" older than {label}? Pinned messages are kept. This cannot be undone.")
    "Contact request" -> L.t("Contact request")
    "\"{name}\" wants to start a conversation with you. Accept it to read the messages and reply." ->
        L.t("\"{name}\" wants to start a conversation with you. Accept it to read the messages and reply.")
    "Accept" -> L.t("Accept")
    // OLD_MESSAGE_SPANS: stable t()s them too; the packs lack some (English shows).
    "1 day" -> L.t("1 day")
    "1 year" -> L.t("1 year")
    else -> L.t(label)
}

private fun chatMenuIcon(name: String?): ImageVector? = when (name) {
    "pin" -> VeltaIcons.pin
    "bell" -> VeltaIcons.bell
    "markRead" -> VeltaIcons.markRead
    "trash" -> VeltaIcons.trash
    "archive" -> VeltaIcons.archive
    else -> null
}

/** Places the popup at a window point, clamped like ui.js placeMenu. */
private class PointPosition(val x: Int, val y: Int, val near: Int, val far: Int) : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val (px, py) = placeMenu(x, y, popupContentSize.width, popupContentSize.height, windowSize.width, windowSize.height, near, far)
        return IntOffset(px, py)
    }
}

/** main.css `.ctx-menu`: bgSidebar, 1px border, radius 12, padding 6,
 *  min-width 210, shadow; light-dismiss (outside tap, Back, Esc). */
@Composable
internal fun CtxMenu(x: Float, y: Float, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val tokens = Velta.tokens
    val density = LocalDensity.current
    val provider = remember(x, y, density) {
        with(density) { PointPosition(x.toInt(), y.toInt(), 8.dp.roundToPx(), 10.dp.roundToPx()) }
    }
    Popup(popupPositionProvider = provider, onDismissRequest = onDismiss, properties = PopupProperties(focusable = true)) {
        val shape = RoundedCornerShape(12.dp)
        Column(
            Modifier
                .shadow(9.dp, shape)
                .background(tokens.bgSidebar, shape)
                .border(1.dp, tokens.border, shape)
                .padding(6.dp)
                .widthIn(min = 210.dp)
                .width(IntrinsicSize.Max),
        ) { content() }
    }
}

/** main.css `.ctx-item`: 20dp icon (text-dim / danger), 14.5px label. */
@Composable
internal fun CtxItem(label: String, icon: ImageVector?, danger: Boolean, onClick: () -> Unit) {
    val tokens = Velta.tokens
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (hovered) tokens.bgHover else androidx.compose.ui.graphics.Color.Transparent)
            .hoverable(interaction)
            .clickable(interactionSource = interaction, indication = androidx.compose.material3.ripple(), onClick = onClick)
            .semantics { role = Role.Button }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (icon != null) Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp), tint = if (danger) tokens.danger else tokens.textDim)
        Text(label, fontSize = 14.5.sp, color = if (danger) tokens.danger else tokens.text)
    }
}

/** main.css `.ctx-sep`: 1px border line, 5/8 margins. */
@Composable
private fun CtxSep() {
    Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 5.dp).height(1.dp).background(Velta.tokens.border))
}

/** The open chat menu (list or ⋮), its "Delete old messages…" spans menu,
 *  confirmations and the group invite. Hosted once at the app root. */
@Composable
internal fun ChatMenuHost(model: AppModel) {
    model.chatMenu?.let { menu ->
        CtxMenu(menu.x, menu.y, onDismiss = { model.closeChatMenu() }) {
            if (menu.spans) {
                OLD_MESSAGE_SPANS.forEach { (label, ms) ->
                    val span = chatMenuLabel(label)
                    CtxItem(L.t("Older than {label}").replace("{label}", span), null, false) {
                        model.onDeleteOldSpan(label, ms, span)
                    }
                }
            } else {
                menu.entries.forEach { e ->
                    if (e.isSeparator) CtxSep()
                    else CtxItem(chatMenuLabel(e.label), chatMenuIcon(e.icon), e.danger) { model.onChatMenuAction(e.action!!) }
                }
            }
        }
    }
    ChatConfirmDialog(model)
    GroupInviteDialog(model)
    // The chat screen hosts its own toast above the composer; elsewhere
    // (chat list actions) the toast sits above the bottom bar.
    if (model.screen !is AppModel.Screen.Chat && model.toast != null) {
        Box(Modifier.fillMaxSize().padding(bottom = 88.dp), contentAlignment = Alignment.BottomCenter) {
            ToastHost(model)
        }
    }
}

/** ui.js confirmModal: compact card, Cancel + the (danger) OK text button. */
@Composable
private fun ChatConfirmDialog(model: AppModel) {
    val pending = model.chatConfirm ?: return
    val tokens = Velta.tokens
    val spec = pending.spec
    var text = chatMenuLabel(spec.text)
    spec.args.forEach { (k, v) -> text = text.replace("{$k}", v) }
    PlatformBackHandler { model.answerChatConfirm(false) }
    SheetModal(
        title = chatMenuLabel(spec.title),
        onClose = { model.answerChatConfirm(false) },
        compact = true,
        foot = {
            TextButton(onClick = { model.answerChatConfirm(false) }) { Text(L.t("Cancel"), color = tokens.accentText) }
            TextButton(onClick = { model.answerChatConfirm(true) }) {
                Text(chatMenuLabel(spec.ok), color = if (spec.danger) tokens.danger else tokens.accentText)
            }
        },
    ) {
        Text(text, fontSize = 15.sp, lineHeight = (15 * 1.45).sp, color = tokens.text)
    }
}

/** ui.js showInvite(group): hint, branded QR, the link, Copy / Share. */
@Composable
private fun GroupInviteDialog(model: AppModel) {
    val state = model.groupInvite ?: return
    val tokens = Velta.tokens
    val clipboard = LocalClipboardManager.current
    val close = { model.groupInvite = null }
    PlatformBackHandler { close() }
    val copied = L.t("Invite link copied")
    SheetModal(title = state.name, onClose = close) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                L.t("Anyone scanning this code can join this group — the joiner is verified end-to-end automatically."),
                fontSize = 14.5.sp,
                lineHeight = (14.5 * 1.5).sp,
                color = tokens.text,
                modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp),
            )
            val link = state.link?.let { rewriteInviteHost(it, model.inviteDomain) ?: it }
            when {
                state.error != null -> Text(L.t("Couldn't create the invite:") + "\n" + state.error, fontSize = 14.sp, color = tokens.textDim)
                link == null -> Text(L.t("Generating QR code…"), fontSize = 14.sp, color = tokens.textDim)
                else -> {
                    Box(Modifier.widthIn(max = 300.dp).clip(RoundedCornerShape(12.dp))) { BrandedQrSquare(link) }
                    Text(link, fontSize = 13.sp, color = tokens.textDim, modifier = Modifier.padding(top = 8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 6.dp)) {
                        TextButton(onClick = { clipboard.setText(AnnotatedString(link)); model.showToast(copied) }) {
                            Icon(VeltaIcons.copy, contentDescription = null, modifier = Modifier.size(18.dp), tint = tokens.accentText)
                            Text(" " + L.t("Copy invite link"), color = tokens.accentText)
                        }
                        val share = model.shareText
                        if (share != null) {
                            TextButton(onClick = { share(L.t("Join {name} on Velta").replace("{name}", state.name) + ": " + link) }) {
                                Icon(VeltaIcons.share, contentDescription = null, modifier = Modifier.size(18.dp), tint = tokens.accentText)
                                Text(" " + L.t("Share"), color = tokens.accentText)
                            }
                        }
                    }
                }
            }
        }
    }
}
