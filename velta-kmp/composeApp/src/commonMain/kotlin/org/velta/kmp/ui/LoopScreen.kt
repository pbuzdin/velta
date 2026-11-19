package org.velta.kmp.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun LoopSettingsRow(model: AppModel) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { model.setLoop(!model.loopOn) }
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(L.t("Velta Loop"))
            Text(
                L.t("Local chat on the same network"),
                fontSize = 12.sp,
                color = Velta.tokens.textDim,
            )
        }
        Checkbox(checked = model.loopOn, onCheckedChange = { model.setLoop(it) })
    }
}

@Composable
fun LoopCard(model: AppModel) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
        Text(L.t("Velta Loop"), fontWeight = FontWeight.SemiBold, color = Velta.tokens.text)
        Text(L.t("Local chat on the same network"), fontSize = 12.sp, color = Velta.tokens.textDim)
        Row {
            TextButton(onClick = { model.showLoopInvite() }) { Text(L.t("Show invite")) }
            TextButton(onClick = { model.openLoopPaste() }) { Text(L.t("Paste code…")) }
        }
        val nearby = model.loopStatus?.nearby.orEmpty()
        if (nearby.isNotEmpty()) {
            Text(L.t("Nearby on the same network"), fontSize = 12.sp, color = Velta.tokens.textDim)
            nearby.forEach { n ->
                TextButton(onClick = { model.pairLoopNearby(n.id) }) {
                    Text(L.t("Pair") + " " + n.name.ifBlank { n.id.take(8) })
                }
            }
        }
    }
}

@Composable
fun LoopListRow(row: LoopRow, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Text(row.title, fontWeight = FontWeight.SemiBold, color = Velta.tokens.text)
        if (row.preview.isNotEmpty()) {
            Text(
                row.preview,
                fontSize = 13.sp,
                color = if (row.typing) Velta.tokens.accent else Velta.tokens.textDim,
                maxLines = 1,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoopChatScreen(model: AppModel, chat: AppModel.Screen.LoopChat) {
    PlatformBackHandler { model.closeLoopChat() }
    val listState = rememberLazyListState()
    LaunchedEffect(model.loopMessages.size) {
        val n = model.loopMessages.size
        if (n > 0) listState.scrollToItem(n - 1)
    }
    var draft by remember(chat.id) { mutableStateOf("") }
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(chat.title)
                        if (model.loopTyping.isNotEmpty()) {
                            Text(model.loopTyping, fontSize = 12.sp, color = Velta.tokens.accent)
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = { model.closeLoopChat() }) {
                        Icon(VeltaIcons.chevronLeft, contentDescription = L.t("Back"))
                    }
                },
            )
        },
    ) { inner ->
        Column(Modifier.padding(inner).fillMaxSize().imePadding()) {
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState) {
                items(model.loopMessages, key = { it.id }) { msg ->
                    val align = when {
                        msg.system -> TextAlign.Center
                        msg.incoming -> TextAlign.Start
                        else -> TextAlign.End
                    }
                    Text(
                        buildString {
                            if (chat.isGroup && msg.incoming && msg.author.isNotBlank()) {
                                append(msg.author)
                                append(": ")
                            }
                            append(msg.text)
                        },
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                        textAlign = align,
                        color = if (msg.system) Velta.tokens.textDim else Velta.tokens.text,
                    )
                }
            }
            Row(
                Modifier.fillMaxWidth().padding(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = {
                        draft = it
                        model.onLoopDraft(it)
                    },
                    modifier = Modifier.weight(1f),
                )
                Button(
                    onClick = {
                        model.sendLoop(draft) { ok ->
                            if (ok) draft = ""
                        }
                    },
                    enabled = draft.isNotBlank(),
                    modifier = Modifier.padding(start = 8.dp),
                ) { Text(L.t("Send")) }
            }
        }
    }
}

@Composable
fun LoopInviteDialog(model: AppModel) {
    val ticket = model.loopInvite ?: return
    val clipboard = LocalClipboardManager.current
    VeltaDialog(
        title = L.t("Show invite"),
        confirmLabel = L.t("Copy"),
        onConfirm = {
            clipboard.setText(AnnotatedString(ticket))
            model.showToast(L.t("Invite code copied"))
            model.dismissLoopInvite()
        },
        onDismiss = { model.dismissLoopInvite() },
    ) {
        Text(ticket)
        Text(
            L.t("Paste the invite code shown on the other device (Local chat → Show invite → Copy code)."),
            fontSize = 12.sp,
            color = Velta.tokens.textDim,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

@Composable
fun LoopPasteDialog(model: AppModel) {
    var code by remember { mutableStateOf("") }
    VeltaDialog(
        title = L.t("Paste code…"),
        confirmLabel = L.t("Pair"),
        onConfirm = { model.acceptLoopTicket(code) },
        onDismiss = { model.dismissLoopPaste() },
        confirmEnabled = code.trim().startsWith("VELTAP2P1:"),
    ) {
        Text(L.t("Paste the invite code shown on the other device (Local chat → Show invite → Copy code)."))
        OutlinedTextField(
            value = code,
            onValueChange = { code = it },
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        )
    }
}

@Composable
fun LoopPairDialog(model: AppModel) {
    val pair = model.loopPair ?: return
    VeltaDialog(
        title = L.t("Pairing request"),
        confirmLabel = L.t("Accept"),
        dismissLabel = L.t("Decline"),
        onConfirm = { model.answerLoopPair(true) },
        onDismiss = { model.answerLoopPair(false) },
    ) {
        Text(pair.second.ifBlank { pair.first })
        Text(L.t("Pair only if you recognize this device."), modifier = Modifier.padding(top = 8.dp))
    }
}

@Composable
fun LoopNewGroupDialog(model: AppModel) {
    var name by remember { mutableStateOf("") }
    val picked = remember { mutableStateListOf<String>() }
    val peers = model.loopStatus?.peers?.filter { it.online }.orEmpty()
    VeltaDialog(
        title = L.t("New local group"),
        confirmLabel = L.t("Create group"),
        onConfirm = { model.createLoopGroup(name, picked.toList()) },
        onDismiss = { model.dismissLoopGroup() },
        confirmEnabled = loopGroupNameOk(name) && loopGroupMembersOk(picked.size),
    ) {
        Text(
            L.t("A local group holds up to {n} devices, you included.").replace("{n}", "5"),
            fontSize = 12.sp,
            color = Velta.tokens.textDim,
        )
        Text(
            L.t("Pick up to {max} paired devices: {count}. Everyone must be online to be added now.")
                .replace("{max}", LOOP_GROUP_MAX_OTHERS.toString())
                .replace("{count}", picked.size.toString()),
            fontSize = 12.sp,
            color = Velta.tokens.textDim,
            modifier = Modifier.padding(top = 4.dp, bottom = 8.dp),
        )
        OutlinedTextField(
            value = name,
            onValueChange = { if (it.length <= LOOP_NAME_MAX) name = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text(L.t("Group name")) },
        )
        peers.forEach { peer ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = peer.id in picked,
                    onCheckedChange = { on ->
                        if (on && picked.size < LOOP_GROUP_MAX_OTHERS && peer.id !in picked) picked.add(peer.id)
                        else if (!on) picked.remove(peer.id)
                    },
                )
                Text(peer.name.ifBlank { peer.id.take(8) })
            }
        }
    }
}
