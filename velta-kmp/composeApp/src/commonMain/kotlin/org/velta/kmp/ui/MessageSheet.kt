package org.velta.kmp.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import org.velta.kmp.core.ChatListItem
import org.velta.kmp.core.MessageObject

/*
 * Stable's phone message sheet (#334 step 5): ui.js showMessageSheet +
 * main.css .ctx-menu.msg-sheet / .msg-reacts / .msg-grid / .msg-del-confirm
 * / .msg-links, plus the flows its items open (forward picker, message
 * info, select text, selection bar, delete undo). Rules live in
 * MessageSheetRules.kt.
 */

/** Stable label of each item — literal L.t keys (the string generator only
 *  sees literal call sites). [short] = the tile caption. */
@Composable
internal fun sheetCaption(a: SheetAction, pinnedLabel: Boolean = false): String = when (a) {
    SheetAction.CopyLink -> L.t("Copy link")
    SheetAction.ShareLink -> L.t("Share link")
    SheetAction.OpenLink -> L.t("Open link")
    SheetAction.Reply -> L.t("Reply")
    SheetAction.ShowReplies -> L.t("Show replies")
    SheetAction.Edit -> L.t("Edit")
    SheetAction.SaveSticker -> L.t("Sticker")
    SheetAction.Download -> L.t("Download")
    SheetAction.Pin -> L.t("Pin")
    SheetAction.Unpin -> L.t("Unpin")
    SheetAction.CopyText -> L.t("Copy")
    SheetAction.SelectText -> L.t("Select text")
    SheetAction.Forward -> L.t("Forward")
    SheetAction.Resend -> L.t("Resend")
    SheetAction.SaveToSaved -> L.t("Save")
    SheetAction.Select -> L.t("Select")
    SheetAction.Info -> L.t("Info")
    SheetAction.Delete -> L.t("Delete")
}

/** Full label for accessibility (stable `it.label`). */
@Composable
private fun sheetFullLabel(a: SheetAction): String = when (a) {
    SheetAction.SaveSticker -> L.t("Save sticker")
    SheetAction.CopyText -> L.t("Copy text")
    SheetAction.SaveToSaved -> L.t("Save to Saved Messages")
    else -> sheetCaption(a)
}

/** chat-view.js ICO per item (outline, stroke 2 — VeltaIcons). */
internal fun sheetIcon(a: SheetAction): ImageVector = when (a) {
    SheetAction.CopyLink, SheetAction.CopyText -> VeltaIcons.copy
    SheetAction.ShareLink -> VeltaIcons.share
    SheetAction.OpenLink -> VeltaIcons.openLink
    SheetAction.Reply -> VeltaIcons.reply
    SheetAction.ShowReplies -> VeltaIcons.thread
    SheetAction.Edit -> VeltaIcons.edit
    SheetAction.SaveSticker, SheetAction.Download -> VeltaIcons.download
    SheetAction.Pin, SheetAction.Unpin -> VeltaIcons.pin
    SheetAction.SelectText -> VeltaIcons.selectText
    SheetAction.Forward -> VeltaIcons.forward
    SheetAction.Resend -> VeltaIcons.resend
    SheetAction.SaveToSaved -> VeltaIcons.star
    SheetAction.Select -> VeltaIcons.selectCircle
    SheetAction.Info -> VeltaIcons.info
    SheetAction.Delete -> VeltaIcons.trash
}

/** .msg-actions .ctx-item fill: --bg (light lifts to white + hairline). */
@Composable
private fun tileFill(): Pair<Color, BorderStroke?> {
    val mode = LocalVeltaThemeMode.current
    return if (mode == VeltaThemeMode.Light) Color.White to BorderStroke(1.dp, Color(0x14101010))
    else Velta.tokens.bg to null
}

/** .ctx-item radius: 12px in the sheet, 6px under brutal. */
@Composable
private fun tileRadius(): Dp = if (LocalVeltaThemeMode.current == VeltaThemeMode.Brutal) 6.dp else 12.dp

/** Bubble long-press target: the stable touch sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MessageSheetHost(model: AppModel) {
    val target = model.messageSheet ?: return
    val tokens = Velta.tokens
    val clipboard = LocalClipboardManager.current
    val uriHandler = LocalUriHandler.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val m = target.message
    val held = m.id in model.deleteHolds
    val items = model.sheetActionsFor(target)
    val (tiles, danger) = messageSheetRows(items)
    val chips = reactionChips(m.reactions)
    val canReact = !held
    val strip = model.stripTrackers
    val href = if (isHttpLink(target.linkHref)) (if (strip) stripTrackingUrl(target.linkHref) else target.linkHref) else ""
    val links = remember(m.id, m.text, target.linkHref) {
        if (held) emptyList() else sheetLinks(messageLinks(m.text), target.linkHref, strip)
    }
    val close = { model.closeMessageSheet() }
    val openLink: (String) -> Unit = { url ->
        val invite = parseInviteLink(url)
        if (invite != null) model.openInviteLink(invite) else runCatching { uriHandler.openUri(url) }
    }
    val copied = L.t("Copied")
    val run: (SheetAction) -> Unit = { a ->
        close()
        when (a) {
            SheetAction.CopyLink -> { clipboard.setText(AnnotatedString(href)); model.showToast(copied) }
            SheetAction.ShareLink -> model.shareText?.invoke(href)
            SheetAction.OpenLink -> openLink(href)
            SheetAction.Reply -> model.startReply(m)
            SheetAction.ShowReplies -> {}
            SheetAction.Edit -> model.startEdit(m)
            SheetAction.SaveSticker -> model.saveSticker(m)
            SheetAction.Download -> model.downloadAttachment(m)
            SheetAction.Pin, SheetAction.Unpin -> model.togglePin(m)
            SheetAction.CopyText -> { clipboard.setText(AnnotatedString(m.text)); model.showToast(copied) }
            SheetAction.SelectText -> model.startSelectText(m)
            SheetAction.Forward -> model.startForward(listOf(m.id))
            SheetAction.Resend -> model.resend(m)
            SheetAction.SaveToSaved -> model.saveToSaved(listOf(m.id))
            SheetAction.Select -> model.enterSelection(m.id)
            SheetAction.Info -> model.showInfo(m)
            SheetAction.Delete -> if (held) model.commitDeleteNow(m.id)
        }
    }
    var picking by remember(m.id) { mutableStateOf(false) }
    var bodyPx by remember(m.id) { mutableIntStateOf(0) }
    val density = LocalDensity.current
    val sheetLabel = L.t("Message actions")
    ModalBottomSheet(
        onDismissRequest = close,
        sheetState = sheetState,
        shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp),
        containerColor = tokens.bgSidebar,
        contentColor = tokens.text,
        tonalElevation = 0.dp,
        dragHandle = { SheetGrab(onClose = close) },
        modifier = Modifier.semantics { contentDescription = sheetLabel },
    ) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val narrow = maxWidth < 340.dp
            // .msg-sheet max-height: min(80vh, 640px).
            val windowH = with(density) { androidx.compose.ui.platform.LocalWindowInfo.current.containerSize.height.toDp() }
            val cap = if (windowH > 0.dp) minOf(windowH * 0.8f, 640.dp) else 640.dp
            if (picking) {
                val locked = with(density) { bodyPx.toDp() }
                EmojiPickerPanel(
                    modifier = Modifier.fillMaxWidth().height(locked.coerceAtLeast(320.dp)),
                    onBack = { picking = false },
                    onPick = { emoji -> close(); model.react(m, emoji) },
                )
            } else {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(max = cap)
                        .onSizeChanged { bodyPx = it.height }
                        .verticalScroll(rememberScrollState())
                        .padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
                ) {
                    if (canReact) {
                        ReactionRow(
                            selected = myReaction(chips),
                            onReact = { emoji -> close(); model.react(m, emoji) },
                            onMore = { picking = true },
                        )
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (tiles.isNotEmpty()) {
                            val cols = if (narrow) 2 else 3
                            tiles.chunked(cols).forEach { row ->
                                Row(
                                    Modifier.fillMaxWidth().height(IntrinsicSize.Min),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    row.forEach { a ->
                                        SheetTile(
                                            a = a,
                                            narrow = narrow,
                                            modifier = Modifier.weight(1f).fillMaxHeight(),
                                            onClick = { run(a) },
                                        )
                                    }
                                    repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                                }
                            }
                        }
                        danger.forEach { a ->
                            if (held) {
                                SheetDangerRow(a) { run(a) }
                            } else {
                                DeleteRowWithConfirm(
                                    canForAll = model.canDeleteForAllIds(listOf(m.id)),
                                    onChoose = { choice -> close(); model.applyDeleteChoice(listOf(m.id), choice) },
                                )
                            }
                        }
                    }
                    if (links.isNotEmpty()) ShowLinks(links) { url -> close(); openLink(url) }
                }
            }
        }
    }
}

/** .msg-sheet-grab: 72×28 button, 44×5 --text-dim bar; tap closes. */
@Composable
private fun SheetGrab(onClose: () -> Unit) {
    val label = L.t("Close menu")
    Box(
        Modifier
            .padding(top = 6.dp, bottom = 6.dp)
            .size(width = 72.dp, height = 28.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClose)
            .semantics { contentDescription = label; role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(width = 44.dp, height = 5.dp).background(Velta.tokens.textDim, RoundedCornerShape(5.dp)))
    }
}

/** .msg-reacts: two rows of six circles — 11 quick reactions + the smiley. */
@Composable
private fun ReactionRow(selected: String?, onReact: (String) -> Unit, onMore: () -> Unit) {
    val tokens = Velta.tokens
    val shown = shownReactions(SHEET_REACTIONS, selected)
    val cells: List<String?> = shown + listOf(null)
    val moreLabel = L.t("More emoji")
    val removeLabel = L.t("Remove reaction {emoji}")
    Column(Modifier.padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        cells.chunked(6).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { emoji ->
                    val mine = emoji != null && emoji == selected
                    Box(
                        Modifier
                            .weight(1f)
                            .aspectRatio(1f)
                            .clip(CircleShape)
                            .background(if (mine) tokens.accent.copy(alpha = 0.18f) else tokens.bgHover)
                            .then(if (mine) Modifier.border(2.dp, tokens.accent, CircleShape) else Modifier)
                            .clickable { if (emoji == null) onMore() else onReact(emoji) }
                            .semantics {
                                role = Role.Button
                                contentDescription = when {
                                    emoji == null -> moreLabel
                                    mine -> removeLabel.replace("{emoji}", emoji)
                                    else -> emoji
                                }
                                if (emoji != null) this.selected = mine
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (emoji == null) {
                            Icon(VeltaIcons.smiley, contentDescription = null, modifier = Modifier.size(22.dp), tint = tokens.text)
                        } else {
                            Text(emoji, fontSize = 22.sp, color = tokens.text)
                        }
                    }
                }
                repeat(6 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** .msg-tile: icon over caption (3 per row); under 340dp icon beside caption. */
@Composable
private fun SheetTile(a: SheetAction, narrow: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val tokens = Velta.tokens
    val (fill, edge) = tileFill()
    val shape = RoundedCornerShape(tileRadius())
    val full = sheetFullLabel(a)
    val base = modifier
        .clip(shape)
        .background(fill, shape)
        .then(if (edge != null) Modifier.border(edge, shape) else Modifier)
        .clickable(onClick = onClick)
        .semantics { contentDescription = full; role = Role.Button }
    if (narrow) {
        Row(
            base.heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(sheetIcon(a), contentDescription = null, modifier = Modifier.size(20.dp), tint = tokens.textDim)
            Text(sheetCaption(a), fontSize = 13.sp, lineHeight = (13 * 1.2).sp, color = tokens.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    } else {
        Column(
            base.heightIn(min = 72.dp).padding(horizontal = 6.dp, vertical = 10.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically),
        ) {
            Icon(sheetIcon(a), contentDescription = null, modifier = Modifier.size(24.dp), tint = tokens.textDim)
            Text(sheetCaption(a), fontSize = 13.sp, lineHeight = (13 * 1.2).sp, color = tokens.text, textAlign = TextAlign.Center)
        }
    }
}

/** Full-width danger row (.msg-row-full .ctx-item.danger). */
@Composable
private fun SheetDangerRow(a: SheetAction, onClick: () -> Unit) {
    val tokens = Velta.tokens
    val (fill, edge) = tileFill()
    val shape = RoundedCornerShape(tileRadius())
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(shape)
            .background(fill, shape)
            .then(if (edge != null) Modifier.border(edge, shape) else Modifier)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(sheetIcon(a), contentDescription = null, modifier = Modifier.size(20.dp), tint = tokens.danger)
        Text(sheetCaption(a), fontSize = 14.5.sp, color = tokens.danger)
    }
}

/** Delete row → inline Cancel / Delete for me / Delete for everyone
 *  (ui.js showInlineDeleteConfirm; 2 choices sit icon-beside-label, 3 stack). */
@Composable
private fun DeleteRowWithConfirm(canForAll: Boolean, onChoose: (DeleteChoice) -> Unit) {
    var confirming by remember { mutableStateOf(false) }
    if (!confirming) {
        SheetDangerRow(SheetAction.Delete) { confirming = true }
        return
    }
    val tokens = Velta.tokens
    val (fill, edge) = tileFill()
    val shape = RoundedCornerShape(tileRadius())
    val choices = deleteConfirmChoices(canForAll)
    val stacked = choices.size == 3
    Row(
        Modifier.fillMaxWidth().height(IntrinsicSize.Min),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        choices.forEach { c ->
            val danger = c != DeleteChoice.Cancel
            val color = if (danger) tokens.danger else tokens.text
            val icon = if (danger) VeltaIcons.trash else VeltaIcons.close
            val label = when (c) {
                DeleteChoice.Cancel -> L.t("Cancel")
                DeleteChoice.ForMe -> L.t("Delete for me")
                DeleteChoice.ForEveryone -> L.t("Delete for everyone")
            }
            val mod = Modifier
                .weight(1f)
                .fillMaxHeight()
                .heightIn(min = 48.dp)
                .clip(shape)
                .background(fill, shape)
                .then(if (edge != null) Modifier.border(edge, shape) else Modifier)
                .clickable { if (c == DeleteChoice.Cancel) confirming = false else onChoose(c) }
            if (stacked) {
                Column(
                    mod.padding(horizontal = 6.dp, vertical = 8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically),
                ) {
                    Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp), tint = if (danger) tokens.danger else tokens.textDim)
                    Text(label, fontSize = 14.sp, lineHeight = (14 * 1.2).sp, color = color, textAlign = TextAlign.Center)
                }
            } else {
                Row(
                    mod.padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp), tint = if (danger) tokens.danger else tokens.textDim)
                    Text(label, fontSize = 14.sp, lineHeight = (14 * 1.2).sp, color = color)
                }
            }
        }
    }
}

/** "Show links" (#161 mobile): a disclosure listing every link in the bubble. */
@Composable
private fun ShowLinks(links: List<String>, onOpen: (String) -> Unit) {
    val tokens = Velta.tokens
    var open by remember { mutableStateOf(false) }
    val title = if (links.size > 1) L.t("Show links ({n})").replace("{n}", links.size.toString()) else L.t("Show links")
    Column(Modifier.padding(top = 10.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .clickable { open = !open }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, fontSize = 14.sp, color = tokens.textDim, modifier = Modifier.weight(1f))
            Text("›", fontSize = 14.sp, color = tokens.textDim, modifier = Modifier.rotate(if (open) 90f else 0f))
        }
        if (open) {
            links.forEach { url ->
                Text(
                    url.replace(Regex("^https?://", RegexOption.IGNORE_CASE), ""),
                    fontSize = 14.sp,
                    color = tokens.accentTextIn,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { onOpen(url) }
                        .padding(horizontal = 12.dp, vertical = 9.dp),
                )
            }
        }
    }
}

/** Every http(s) link markdownAnnotated renders for [text] (URL + invite annotations). */
internal fun messageLinks(text: String): List<String> {
    if (text.isBlank()) return emptyList()
    val ann = markdownAnnotated(text, Color.Unspecified, Color.Unspecified, Color.Unspecified)
    return ann.getStringAnnotations(0, ann.length)
        .filter { it.tag == ANN_URL || it.tag == ANN_INVITE }
        .map { it.item }
}

/** Sheet emoji picker (ui.js buildEmojiTray): Back + search + 8-column grid,
 *  at the sheet's locked height. A pick reacts and closes. */
@Composable
private fun EmojiPickerPanel(modifier: Modifier, onBack: () -> Unit, onPick: (String) -> Unit) {
    val tokens = Velta.tokens
    var query by remember { mutableStateOf("") }
    PlatformBackHandler { query = ""; onBack() }
    val found = EmojiData.search(query)
    Column(modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp)) {
        Row(
            Modifier
                .padding(bottom = 8.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(tokens.bgHover)
                .clickable { query = ""; onBack() }
                .padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(VeltaIcons.arrowLeft, contentDescription = null, modifier = Modifier.size(18.dp), tint = tokens.text)
            Text(L.t("Back"), fontSize = 14.sp, color = tokens.text)
        }
        val searchLabel = L.t("Search emoji")
        BasicTextField(
            value = query,
            onValueChange = { query = it },
            singleLine = true,
            textStyle = TextStyle(fontSize = 15.sp, color = tokens.text),
            cursorBrush = SolidColor(tokens.accent),
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 8.dp)
                .background(tokens.bg, RoundedCornerShape(10.dp))
                .border(1.dp, tokens.border, RoundedCornerShape(10.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .semantics { contentDescription = searchLabel },
            decorationBox = { inner ->
                Box {
                    if (query.isEmpty()) Text(searchLabel, fontSize = 15.sp, color = tokens.textDim)
                    inner()
                }
            },
        )
        if (found.isEmpty()) {
            Text(L.t("No emoji"), fontSize = 14.sp, color = tokens.textDim, modifier = Modifier.padding(8.dp))
        } else {
            LazyVerticalGrid(columns = GridCells.Fixed(8), modifier = Modifier.fillMaxWidth().weight(1f)) {
                items(found, key = { it.first }) { (emoji, name) ->
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { onPick(emoji) }
                            .padding(4.dp)
                            .semantics { contentDescription = name; role = Role.Button },
                        contentAlignment = Alignment.Center,
                    ) { Text(emoji, fontSize = 24.sp, lineHeight = (24 * 1.2).sp) }
                }
            }
        }
    }
}

/** Stable modal shell (ui.js showModal): full screen on phones, a card
 *  otherwise; compact keeps the floating card (confirmations). */
@Composable
internal fun SheetModal(
    title: String,
    onClose: () -> Unit,
    compact: Boolean = false,
    foot: (@Composable () -> Unit)? = null,
    body: @Composable () -> Unit,
) {
    val tokens = Velta.tokens
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val full = !compact && maxWidth < 600.dp
            val shape = if (full) RoundedCornerShape(0.dp) else RoundedCornerShape(16.dp)
            Box(
                Modifier.fillMaxSize().clickable(
                    interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
                    indication = null,
                ) { onClose() },
            )
            Column(
                Modifier
                    .align(Alignment.Center)
                    .then(if (full) Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.statusBars).windowInsetsPadding(WindowInsets.navigationBars) else Modifier.padding(16.dp).widthIn(max = 460.dp).fillMaxWidth())
                    .background(tokens.bgSidebar, shape)
                    .then(if (full) Modifier else Modifier.border(1.dp, tokens.border, shape))
                    .clickable(
                        interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
                        indication = null,
                    ) {},
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = tokens.text, modifier = Modifier.weight(1f))
                    IconButton(onClick = onClose) {
                        Icon(VeltaIcons.close, contentDescription = L.t("Close"), modifier = Modifier.size(22.dp), tint = tokens.textDim)
                    }
                }
                Column(
                    (if (full) Modifier.weight(1f) else Modifier.heightIn(max = 520.dp))
                        .padding(start = 16.dp, end = 16.dp, bottom = if (foot == null) 16.dp else 0.dp),
                ) { body() }
                if (foot != null) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End),
                        verticalAlignment = Alignment.CenterVertically,
                    ) { foot() }
                }
            }
        }
    }
}

/** app.js forwardFlow: "Forward to…" with chat search; a tap forwards. */
@Composable
internal fun ForwardPicker(model: AppModel, row: @Composable (ChatListItem, () -> Unit) -> Unit) {
    if (model.forwardIds == null) return
    val tokens = Velta.tokens
    var query by remember { mutableStateOf("") }
    val close = { model.forwardIds = null }
    PlatformBackHandler { close() }
    SheetModal(title = L.t("Forward to…"), onClose = close) {
        val searchLabel = L.t("Search chats")
        BasicTextField(
            value = query,
            onValueChange = { query = it },
            singleLine = true,
            textStyle = TextStyle(fontSize = 15.sp, color = tokens.text),
            cursorBrush = SolidColor(tokens.accent),
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 8.dp)
                .background(tokens.bg, RoundedCornerShape(10.dp))
                .border(1.dp, tokens.border, RoundedCornerShape(10.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .semantics { contentDescription = searchLabel },
            decorationBox = { inner ->
                Box {
                    if (query.isEmpty()) Text(L.t("Search chats…"), fontSize = 15.sp, color = tokens.textDim)
                    inner()
                }
            },
        )
        val q = query.trim().lowercase()
        val targets = model.forwardTargets().filter { q.isEmpty() || it.name.lowercase().contains(q) }
        if (targets.isEmpty()) {
            Text(L.t("No chats match."), fontSize = 14.sp, color = tokens.textDim, modifier = Modifier.padding(8.dp))
        } else {
            LazyColumn(Modifier.fillMaxWidth()) {
                items(targets, key = { it.id }) { chat -> row(chat) { model.forwardTo(chat) } }
            }
        }
    }
}

/** chat-view _showInfo: Type / From / Sent / Received / State / reactions /
 *  Database ID / Message-ID / Server URL. */
@Composable
internal fun MessageInfoDialog(model: AppModel, senderName: (Long) -> String?) {
    val info = model.messageInfo ?: return
    val m = info.message
    val tokens = Velta.tokens
    val close = { model.messageInfo = null }
    PlatformBackHandler { close() }
    SheetModal(title = L.t("Message info"), onClose = close) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            val (seenKey, encKey) = messageInfoStateKeys(m)
            val seen = if (seenKey == "Seen") L.t("Seen") else L.t("Not seen")
            val enc = if (encKey == "Encrypted") L.t("Encrypted") else L.t("Not encrypted")
            var state = "$seen, $enc"
            if (m.state == 24 && !m.error.isNullOrBlank()) state += ": ${m.error}"
            val from = if (m.fromId == 1L) L.t("You")
            else m.overrideSenderName ?: m.sender?.displayName?.ifBlank { null } ?: senderName(m.fromId) ?: ""
            InfoRow(L.t("Type"), stableViewtype(m.viewType))
            InfoRow(L.t("From"), from)
            InfoRow(L.t("Sent"), formatInfoDateTime(m.timestamp))
            InfoRow(L.t("Received"), if (m.receivedTimestamp > 0) formatInfoDateTime(m.receivedTimestamp) else "—")
            InfoRow(L.t("State"), state)
            val chips = reactionChips(m.reactions)
            if (chips.isNotEmpty()) {
                Row(Modifier.padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    chips.forEach { c ->
                        Text(
                            if (c.count > 1) "${c.emoji} ${c.count}" else c.emoji,
                            fontSize = 13.sp,
                            color = tokens.text,
                            modifier = Modifier
                                .clip(RoundedCornerShape(12.dp))
                                .background(if (c.mine) tokens.accent.copy(alpha = 0.18f) else tokens.bgHover)
                                .border(1.dp, if (c.mine) tokens.accent else tokens.border, RoundedCornerShape(12.dp))
                                .clickable { model.react(m, c.emoji); close() }
                                .padding(horizontal = 8.dp, vertical = 2.dp),
                        )
                    }
                }
            }
            InfoRow(L.t("Database ID"), "#${m.id}")
            InfoRow("Message-ID", info.rfc724Mid?.ifEmpty { "—" } ?: "…", wrap = true)
            InfoRow(
                L.t("Server URL"),
                info.serverUrls?.map { formatServerUrl(it) }?.filter { it.isNotEmpty() }?.joinToString("\n")?.ifEmpty { "—" } ?: "…",
                wrap = true,
            )
        }
    }
}

@Composable
private fun InfoRow(k: String, v: String, wrap: Boolean = false) {
    val tokens = Velta.tokens
    if (wrap) {
        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            Text(k, fontSize = 14.sp, color = tokens.textDim)
            SelectionContainer { Text(v, fontSize = 14.sp, color = tokens.text) }
        }
    } else {
        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            Text(k, fontSize = 14.sp, color = tokens.textDim, modifier = Modifier.weight(0.4f))
            SelectionContainer(Modifier.weight(0.6f)) { Text(v, fontSize = 14.sp, color = tokens.text) }
        }
    }
}

/** Select text (stable in-bubble selection + Reply / Copy / Close): the
 *  message text in a native selection container. */
@Composable
internal fun SelectTextDialog(model: AppModel) {
    val m = model.selectTextFor ?: return
    val tokens = Velta.tokens
    val clipboard = LocalClipboardManager.current
    val close = { model.selectTextFor = null }
    val copied = L.t("Copied")
    PlatformBackHandler { close() }
    SheetModal(
        title = L.t("Select text"),
        onClose = close,
        compact = true,
        foot = {
            if (!model.sheetChat.readOnly) TextButton(onClick = { close(); model.startReply(m) }) { Text(L.t("Reply"), color = tokens.accentText) }
            TextButton(onClick = { clipboard.setText(AnnotatedString(m.text)); model.showToast(copied); close() }) { Text(L.t("Copy"), color = tokens.accentText) }
            TextButton(onClick = close) { Text(L.t("Close"), color = tokens.accentText) }
        },
    ) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            SelectionContainer { Text(m.text, fontSize = 15.5.sp, lineHeight = (15.5f * 1.36f).sp, color = tokens.text) }
        }
    }
}

/** ui.js confirmDeleteMessagesModal (selection bar Delete). */
@Composable
internal fun DeleteMessagesDialog(model: AppModel) {
    val ids = model.deleteConfirmIds ?: return
    val tokens = Velta.tokens
    val close = { model.deleteConfirmIds = null }
    val canForAll = model.canDeleteForAllIds(ids)
    PlatformBackHandler { close() }
    SheetModal(
        title = L.t("Delete messages"),
        onClose = close,
        compact = true,
        foot = {
            TextButton(onClick = close) { Text(L.t("Cancel"), color = tokens.accentText) }
            TextButton(onClick = { model.applyDeleteChoice(ids, DeleteChoice.ForMe) }) { Text(L.t("Delete for me"), color = tokens.danger) }
            if (canForAll) TextButton(onClick = { model.applyDeleteChoice(ids, DeleteChoice.ForEveryone) }) { Text(L.t("Delete for everyone"), color = tokens.danger) }
        },
    ) {
        Text(
            if (ids.size == 1) L.t("Delete this message?") else L.t("Delete {n} messages?").replace("{n}", ids.size.toString()),
            fontSize = 15.sp,
            lineHeight = (15 * 1.45).sp,
            color = tokens.text,
        )
    }
}

/** index.html #selection-bar: Close, count, then Reply / Forward / Copy /
 *  Save to Saved Messages / Delete / Message info. */
@Composable
internal fun SelectionBar(model: AppModel, modifier: Modifier = Modifier) {
    val tokens = Velta.tokens
    val clipboard = LocalClipboardManager.current
    val copiedN = L.t("Copied {n} messages")
    PlatformBackHandler { model.exitSelection() }
    Row(
        modifier.fillMaxWidth().height(56.dp).padding(start = 6.dp, end = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = { model.exitSelection() }) {
            Icon(VeltaIcons.close, contentDescription = L.t("Cancel selection"), modifier = Modifier.size(22.dp), tint = tokens.text)
        }
        Text(
            model.selection.size.toString(),
            fontSize = 17.sp,
            fontWeight = FontWeight.SemiBold,
            color = tokens.text,
            modifier = Modifier.padding(horizontal = 6.dp),
        )
        Spacer(Modifier.weight(1f))
        @Composable
        fun act(icon: ImageVector, label: String, onClick: () -> Unit) {
            IconButton(onClick = onClick) { Icon(icon, contentDescription = label, modifier = Modifier.size(22.dp), tint = tokens.text) }
        }
        if (!model.sheetChat.readOnly) act(VeltaIcons.reply, L.t("Reply")) { model.selectionReply() }
        act(VeltaIcons.forward, L.t("Forward")) { model.startForward(model.selection) }
        act(VeltaIcons.copy, L.t("Copy")) {
            val (text, n) = model.selectionText()
            clipboard.setText(AnnotatedString(text))
            model.showToast(copiedN.replace("{n}", n.toString()))
            model.exitSelection()
        }
        act(VeltaIcons.star, L.t("Save to Saved Messages")) { model.saveToSaved(model.selection, fromSelection = true) }
        act(VeltaIcons.trash, L.t("Delete")) { model.deleteConfirmIds = model.selection }
        act(VeltaIcons.info, L.t("Message info")) { model.selectionInfo() }
    }
}

/** .msg-checkbox: 22dp circle, --text-dim ring; selected = accent fill + tick. */
@Composable
internal fun SelectCheck(selected: Boolean) {
    val tokens = Velta.tokens
    val label = L.t("Select message")
    Box(
        Modifier
            .size(22.dp)
            .clip(CircleShape)
            .background(if (selected) tokens.accent else Color.Transparent)
            .border(2.dp, if (selected) tokens.accent else tokens.textDim, CircleShape)
            .semantics { contentDescription = label; this.selected = selected },
        contentAlignment = Alignment.Center,
    ) {
        if (selected) Icon(VeltaIcons.check, contentDescription = null, modifier = Modifier.size(14.dp), tint = Color(0xFFF4F4F4))
    }
}

/** Delete hold tombstone (.bubble.msg-deleted + .msg-undo with the
 *  shrinking accent bar); compact "Message deleted" once committed. */
@Composable
internal fun DeletedBubble(
    model: AppModel,
    message: MessageObject,
    outgoing: Boolean,
    minHeight: Dp,
    shape: androidx.compose.ui.graphics.Shape,
) {
    val tokens = Velta.tokens
    val mode = LocalVeltaThemeMode.current
    val hold = model.deleteHolds[message.id]
    val ink = when {
        outgoing && mode == VeltaThemeMode.Brutal -> tokens.textOut
        outgoing -> lerp(tokens.text, tokens.textMetaOut, 0.8f)
        else -> lerp(tokens.text, tokens.textDim, 0.8f)
    }
    val compact = hold == null
    Row(
        Modifier
            .widthIn(max = 320.dp)
            .heightIn(min = if (compact) 0.dp else minHeight)
            .background(if (outgoing) tokens.bgBubbleOut else tokens.bgBubbleIn, shape)
            .padding(horizontal = 10.dp, vertical = if (compact) 4.dp else 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            if (compact) L.t("Message deleted") else L.t("This message was deleted"),
            fontSize = if (compact) 13.sp else 14.sp,
            lineHeight = ((if (compact) 13 else 14) * 1.35).sp,
            fontStyle = FontStyle.Italic,
            color = ink,
        )
        if (hold != null && !hold.committing) {
            var progress by remember(hold.key) { mutableStateOf(1f) }
            LaunchedEffect(hold.key) {
                while (true) {
                    val left = (hold.ms - (model.wallClockMillis() - hold.startedAt)).coerceAtLeast(0)
                    progress = left.toFloat() / hold.ms
                    if (left <= 0) break
                    kotlinx.coroutines.delay(50)
                }
            }
            val undoBg = when {
                mode == VeltaThemeMode.Light -> Color(0x14101010)
                outgoing && mode == VeltaThemeMode.Brutal -> Color(0x1A121016)
                else -> Color(0x24F4F4F4)
            }
            val undoInk = if (outgoing && mode == VeltaThemeMode.Brutal) tokens.textOut else tokens.text
            Box(
                Modifier
                    .heightIn(min = 32.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(undoBg)
                    .clickable { model.undoDelete(message.id) },
            ) {
                Text(
                    L.t("Undo"),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = undoInk,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 8.dp),
                )
                Box(
                    Modifier
                        .align(Alignment.BottomStart)
                        .fillMaxWidth(progress)
                        .height(2.dp)
                        .background(tokens.accent),
                )
            }
        }
    }
}

/** Stable toast: a short line above the composer. */
@Composable
internal fun ToastHost(model: AppModel, modifier: Modifier = Modifier) {
    val text = model.toast ?: return
    val tokens = Velta.tokens
    Box(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
        Text(
            text,
            fontSize = 14.sp,
            color = tokens.text,
            modifier = Modifier
                .background(tokens.bgElev, RoundedCornerShape(12.dp))
                .border(1.dp, tokens.border, RoundedCornerShape(12.dp))
                .padding(horizontal = 14.dp, vertical = 10.dp),
        )
    }
}

/** Message info timestamps: the day header + clock (stable formatDateTime). */
internal fun formatInfoDateTime(epochSeconds: Long): String =
    "${formatDateHeader(epochSeconds)} ${formatTimestamp(epochSeconds)}"
