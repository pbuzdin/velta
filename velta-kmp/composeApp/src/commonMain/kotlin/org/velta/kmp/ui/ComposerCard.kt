package org.velta.kmp.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.velta.kmp.core.MessageObject

/** Thumbnail decode cap: 64dp boxes at up to 4× density. */
private const val CARD_THUMB_MAX_SIDE = 256

/** What the card shows; kept while it animates out so the content doesn't blank. */
private data class CardContent(
    val reply: MessageObject?,
    val editing: MessageObject?,
    val attachment: Pair<String, String>?,
)

/**
 * Variant A "floating card" (#334, picked by Pavel; mockup
 * reply-bar-previews/variant-A-floating-card): a rounded, elevated card
 * floating above the composer. Reply (accent bar, avatar or the quoted
 * media's thumbnail, "Reply to …" + snippet, ✕), edit, and the staged
 * attachment (thumbnail with ✕, play/duration badge, Edit) share it.
 * Slides/fades in and out; reduced motion shows and hides it at once.
 */
@Composable
internal fun ComposerCard(model: AppModel, modifier: Modifier = Modifier) {
    val now = CardContent(model.replyTo, model.editingMsg, model.pendingAttachment)
    val visible = composerCardRows(now.reply != null, now.editing != null, now.attachment != null).isNotEmpty()
    var shown by remember { mutableStateOf(now) }
    if (visible) shown = now
    val fancy = !rememberReducedMotion()
    AnimatedVisibility(
        visible = visible,
        modifier = modifier,
        enter = if (fancy) {
            slideInVertically(spring(dampingRatio = 0.85f, stiffness = Spring.StiffnessMediumLow)) { it / 2 } + fadeIn(tween(160))
        } else EnterTransition.None,
        exit = if (fancy) slideOutVertically(tween(160)) { it / 2 } + fadeOut(tween(120)) else ExitTransition.None,
    ) {
        CardBody(model, shown, fancy)
    }
}

@Composable
private fun CardBody(model: AppModel, c: CardContent, fancy: Boolean) {
    val tokens = Velta.tokens
    val shape = RoundedCornerShape(16.dp)
    // Dark: the elevated surface; light: the sidebar tone over the chat
    // backdrop (#f4f4f4 on #e7ebf0) — the shadow carries the lift.
    val cardBg = if (tokens.isDark) tokens.bgElev else tokens.bgSidebar
    val rows = composerCardRows(c.reply != null, c.editing != null, c.attachment != null)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 6.dp)
            .shadow(6.dp, shape, clip = false)
            .clip(shape)
            .background(cardBg)
            .border(1.dp, tokens.border, shape)
            .then(if (fancy) Modifier.animateContentSize(spring(stiffness = Spring.StiffnessMediumLow)) else Modifier),
    ) {
        rows.forEachIndexed { i, row ->
            if (i > 0) Box(Modifier.padding(horizontal = 10.dp).fillMaxWidth().height(1.dp).background(tokens.border))
            when (row) {
                CardRow.Edit -> c.editing?.let { EditRow(model, it) }
                CardRow.Reply -> c.reply?.let { ReplyRow(model, it) }
                CardRow.Attachment -> c.attachment?.let { AttachmentRow(model, it.first, it.second) }
            }
        }
    }
}

@Composable
private fun AccentBar() {
    Box(Modifier.width(3.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(Velta.tokens.accent))
}

@Composable
private fun ReplyRow(model: AppModel, m: MessageObject) {
    val tokens = Velta.tokens
    val name = pinSenderName(m, L.t("You")).ifBlank { L.t("Message") }
    val thumbKind = replyThumbKind(m)
    Row(
        Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(start = 10.dp, top = 8.dp, bottom = 8.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        AccentBar()
        if (thumbKind != null) {
            MediaThumb(m.file!!, thumbKind, size = 40, radius = 8, badges = false)
        } else {
            val c = m.sender
            AvatarTile(
                name = name,
                colorHex = c?.color,
                kind = "single",
                size = 32.dp,
                avatarPath = c?.profileImage,
            )
        }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(VeltaIcons.reply, contentDescription = null, tint = tokens.accentText, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(4.dp))
                Text(
                    L.t("Reply to {name}").replace("{name}", name),
                    color = tokens.accentText, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                replySnippet(m) { L.t(it) },
                color = tokens.textDim, fontSize = 13.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        // Thread lock: the bar stays on the parent until the panel closes.
        if (model.threadParentId == null) {
            IconButton(onClick = { model.replyTo = null }) {
                Icon(VeltaIcons.close, contentDescription = L.t("Cancel reply"), tint = tokens.textDim, modifier = Modifier.size(20.dp))
            }
        }
    }
}

@Composable
private fun EditRow(model: AppModel, m: MessageObject) {
    val tokens = Velta.tokens
    Row(
        Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(start = 10.dp, top = 8.dp, bottom = 8.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        AccentBar()
        Box(
            Modifier.size(32.dp).clip(CircleShape).background(tokens.bgReply),
            contentAlignment = Alignment.Center,
        ) { Icon(VeltaIcons.edit, contentDescription = null, tint = tokens.accentText, modifier = Modifier.size(18.dp)) }
        Column(Modifier.weight(1f)) {
            Text(
                L.t("Editing message"),
                color = tokens.accentText, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
            )
            Text(replySnippet(m) { L.t(it) }, color = tokens.textDim, fontSize = 13.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconButton(onClick = { model.cancelEdit() }) {
            Icon(VeltaIcons.close, contentDescription = L.t("Close"), tint = tokens.textDim, modifier = Modifier.size(20.dp))
        }
    }
}

/** Decoded thumbnail (+ duration for videos) for a file, off the main thread. */
@Composable
private fun rememberThumb(path: String, kind: String): Pair<ImageBitmap?, Long> {
    var thumb by remember(path) { mutableStateOf<ImageBitmap?>(null) }
    var dur by remember(path) { mutableStateOf(0L) }
    LaunchedEffect(path, kind) {
        withContext(Dispatchers.Default) {
            when (kind) {
                "image" -> thumb = decodeImageScaled(path, CARD_THUMB_MAX_SIDE)
                "video" -> readVideoInfo(path, CARD_THUMB_MAX_SIDE)?.let { thumb = it.frame; dur = it.durationMs }
            }
        }
    }
    return thumb to dur
}

@Composable
private fun MediaThumb(
    path: String,
    kind: String,
    size: Int,
    radius: Int,
    badges: Boolean,
    onRemove: (() -> Unit)? = null,
    durationOut: (Long) -> Unit = {},
) {
    val tokens = Velta.tokens
    val (thumb, dur) = rememberThumb(path, kind)
    LaunchedEffect(dur) { durationOut(dur) }
    Box(Modifier.size(size.dp)) {
        Box(
            Modifier.size(size.dp).clip(RoundedCornerShape(radius.dp)).background(tokens.bgHover),
            contentAlignment = Alignment.Center,
        ) {
            if (thumb != null) {
                Image(thumb, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(size.dp))
            } else {
                Icon(
                    when (kind) { "image" -> VeltaIcons.photo; "video" -> VeltaIcons.video; else -> VeltaIcons.file },
                    contentDescription = null, tint = tokens.textDim, modifier = Modifier.size((size / 2.6f).dp),
                )
            }
            if (kind == "video") {
                // White on a ≥60% black scrim stays AA over any frame.
                Box(
                    Modifier.size((size * 0.42f).dp).clip(CircleShape).background(Color(0x99000000)),
                    contentAlignment = Alignment.Center,
                ) { Icon(VeltaIcons.playFilled, contentDescription = null, tint = Color.White, modifier = Modifier.size((size * 0.22f).dp)) }
                if (badges && dur > 0) {
                    Text(
                        formatClipDuration(dur),
                        color = Color.White, fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.align(Alignment.BottomStart).padding(4.dp)
                            .clip(RoundedCornerShape(6.dp)).background(Color(0xAD000000))
                            .padding(horizontal = 5.dp, vertical = 1.dp),
                    )
                }
            }
        }
        if (onRemove != null) {
            // 24dp visual badge on a 32dp hit area (WCAG 2.5.8 target size).
            Box(
                Modifier.align(Alignment.TopEnd).offset(x = 8.dp, y = (-8).dp)
                    .size(32.dp)
                    .clip(CircleShape)
                    .clickable(role = Role.Button, onClickLabel = L.t("Remove attachment"), onClick = onRemove)
                    .semantics { contentDescription = L.t("Remove attachment") },
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier.size(22.dp).clip(CircleShape).background(Color(0xAD0A0A0E)),
                    contentAlignment = Alignment.Center,
                ) { Icon(VeltaIcons.close, contentDescription = null, tint = Color.White, modifier = Modifier.size(13.dp)) }
            }
        }
    }
}

@Composable
private fun AttachmentRow(model: AppModel, path: String, name: String) {
    val tokens = Velta.tokens
    val kind = remember(name) { stagedKind(name) }
    var editing by remember(path) { mutableStateOf(false) }
    var duration by remember(path) { mutableStateOf(0L) }
    if (editing) {
        ImageEditorDialog(
            path = path,
            name = name,
            onDone = { p, n -> editing = false; model.onAttachmentEdited(p, n) },
            onCancel = { editing = false },
        )
    }
    Row(
        Modifier.fillMaxWidth().padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        MediaThumb(
            path, kind, size = 64, radius = 10, badges = true,
            onRemove = { model.pendingAttachment = null },
            durationOut = { duration = it },
        )
        Column(Modifier.weight(1f)) {
            Text(
                name.ifBlank { L.t(if (kind == "video") "Video" else "Photo") },
                color = tokens.text, fontSize = 13.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(stagedDetail(kind, duration) { L.t(it) }, color = tokens.textDim, fontSize = 12.5.sp, maxLines = 1)
        }
        if (kind == "image" && canEditImage(name)) {
            Box(
                Modifier.size(40.dp).clip(CircleShape).background(tokens.bgReply)
                    .clickable(role = Role.Button, onClickLabel = L.t("Edit")) { editing = true }
                    .semantics { contentDescription = L.t("Edit") },
                contentAlignment = Alignment.Center,
            ) { Icon(VeltaIcons.edit, contentDescription = null, tint = tokens.accentText, modifier = Modifier.size(20.dp)) }
        }
    }
}
