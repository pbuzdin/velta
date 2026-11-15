package org.velta.kmp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Picker chip labels (components.js buildCategoryChips) as L.t literals. */
private fun shareCatLabel(cat: String): String = when (cat) {
    "all" -> L.t("All")
    "people" -> L.t("People")
    "groups" -> L.t("Groups")
    "channels" -> L.t("Channels")
    "bots" -> L.t("Bots")
    else -> L.t("Saved")
}

/**
 * share-in.js buildSharePicker in the "Share to…" modal: search, the
 * profile chips when there are several profiles, the picker category
 * chips and the chat rows. Hosted at the app root (shares can land on any
 * screen); waits for the app to be ready (createShareInbox.ready()).
 */
@Composable
internal fun SharePickerHost(model: AppModel) {
    LaunchedEffect(model.screen, model.locked, model.accountId, model.connected) { model.flushShares() }
    if (model.sharePick == null) return
    val tokens = Velta.tokens
    var query by remember { mutableStateOf("") }
    var cat by remember { mutableStateOf("all") }
    PlatformBackHandler { model.cancelShare() }
    SheetModal(title = L.t("Share to…"), onClose = { model.cancelShare() }) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            val searchLabel = L.t("Search chats")
            BasicTextField(
                value = query,
                onValueChange = { query = it },
                singleLine = true,
                textStyle = TextStyle(fontSize = 15.sp, color = tokens.text),
                cursorBrush = SolidColor(tokens.accent),
                modifier = Modifier
                    .fillMaxWidth()
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
            // .share-accounts: pill per profile; the current one is filled.
            if (model.accounts.size > 1) {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    model.accounts.forEach { a ->
                        val current = a.id == model.accountId
                        val label = a.displayName?.ifBlank { null } ?: a.addr?.ifBlank { null } ?: "Profile ${a.id}"
                        Text(
                            label,
                            fontSize = 13.5.sp,
                            color = if (current) tokens.onAccent else tokens.text,
                            modifier = Modifier
                                .clip(RoundedCornerShape(999.dp))
                                .background(if (current) tokens.accent else Color.Transparent)
                                .border(1.dp, if (current) tokens.accent else tokens.border, RoundedCornerShape(999.dp))
                                .then(if (current) Modifier else Modifier.clickable { model.pickShareAccount(a.id) })
                                .semantics { role = Role.Button; selected = current }
                                .padding(horizontal = 12.dp, vertical = 5.dp),
                        )
                    }
                }
            }
            // .chat-cats.modal-cats: whole labels, scroll instead of ellipsis.
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                SHARE_CATEGORIES.forEach { c ->
                    val active = c == cat
                    Text(
                        shareCatLabel(c),
                        fontSize = 11.5.sp,
                        lineHeight = 11.5.sp,
                        color = if (active) tokens.onAccentChip else tokens.textDim,
                        modifier = Modifier
                            .clip(RoundedCornerShape(999.dp))
                            .background(if (active) tokens.accent else tokens.bgHover)
                            .clickable { cat = c }
                            .semantics { role = Role.Tab; selected = active }
                            .padding(horizontal = 10.dp, vertical = 5.dp),
                    )
                }
            }
            val targets = model.shareTargetsFor(query, cat)
            if (targets.isEmpty()) {
                Text(
                    if (query.isNotBlank()) L.t("No matching chat.") else L.t("No chat to share to."),
                    fontSize = 14.sp,
                    color = tokens.textDim,
                    modifier = Modifier.padding(8.dp),
                )
            } else {
                LazyColumn(Modifier.fillMaxWidth()) {
                    items(targets, key = { it.id }) { chat ->
                        ContactLikeChatRow(chat, subSize = 14.sp) { model.pickShareChat(chat) }
                    }
                }
            }
        }
    }
}
