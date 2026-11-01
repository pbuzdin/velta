package org.velta.kmp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import org.velta.kmp.core.ChatListItem
import org.velta.kmp.core.MessageObject
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/** P1 read-path UI: login, chat list, chat view. Bare bones by design (issue #192). */
@Composable
fun App(model: AppModel) {
    VeltaTheme {
        Surface(modifier = Modifier.fillMaxSize()) {
            when (val current = model.screen) {
                AppModel.Screen.Login -> LoginScreen(model)
                AppModel.Screen.ChatList -> ChatListScreen(model)
                AppModel.Screen.Relays -> RelaysScreen(model)
                AppModel.Screen.Accounts -> AccountsScreen(model)
                AppModel.Screen.Join -> JoinScreen(model)
                is AppModel.Screen.Chat -> ChatScreen(model, current)
            }
        }
    }
}

@Composable
private fun LoginScreen(model: AppModel) {
    var addr by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Velta", style = MaterialTheme.typography.displaySmall)
        Text(
            "KMP client · core ${model.coreVersion} · ${model.status}",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.size(32.dp))

        OutlinedTextField(
            value = addr,
            onValueChange = { addr = it },
            label = { Text("Address") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.size(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.size(16.dp))

        Button(
            onClick = { model.login(addr.trim(), password) },
            enabled = model.connected && !model.loginBusy && addr.isNotBlank() && password.isNotBlank(),
        ) {
            Text(if (model.loginBusy) "Configuring…" else "Sign in")
        }
        model.loginProgress?.let {
            Spacer(Modifier.size(8.dp))
            Text(it, style = MaterialTheme.typography.bodySmall)
        }
        model.loginError?.let {
            Spacer(Modifier.size(8.dp))
            Text(
                it,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        if (!model.connected) {
            Spacer(Modifier.size(16.dp))
            Text(
                model.status,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.size(24.dp))
        Text(
            "P1 bridge demo — use a throwaway account",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(onClick = {
            model.joinText = ""
            model.joinChecked = null
            model.joinError = null
            model.screen = AppModel.Screen.Join
        }) { Text("Have an invite code? Join with it →") }
    }
}

/** P4: account switcher — the core persists the selected account across restarts. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AccountsScreen(model: AppModel) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Accounts") },
                navigationIcon = {
                    TextButton(onClick = { model.backFromAccounts() }) { Text("‹ Back") }
                },
                actions = {
                    if (model.accountsLoading) CircularProgressIndicator(Modifier.size(20.dp))
                    Spacer(Modifier.size(12.dp))
                },
            )
        },
    ) { inner ->
        LazyColumn(Modifier.padding(inner)) {
            items(model.accounts, key = { it.id }) { account ->
                val current = account.id == model.accountId
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(enabled = account.isConfigured == true) {
                            if (!current) model.switchAccount(account.id)
                        }
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            account.addr ?: "Not set up",
                            fontWeight = if (current) FontWeight.Bold else FontWeight.Normal,
                        )
                        if (account.isConfigured != true) {
                            Text(
                                "not set up — sign in to configure",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    if (current) {
                        Text(
                            "current",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
                HorizontalDivider()
            }
            item {
                TextButton(
                    onClick = { model.addAccountFromSwitcher() },
                    modifier = Modifier.padding(16.dp),
                ) { Text("+ Add account") }
            }
            item {
                BatteryRow(model)
            }
        }
    }
}

/** P4: battery-allowance row — restricted batteries kill the sync service. */
@Composable
private fun BatteryRow(model: AppModel) {
    val exempt = model.batteryExempt ?: return // desktop / not reportable
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { model.requestBatteryAllowance() }
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("Battery optimization")
            Text(
                if (exempt) "exempt — background sync survives battery savers"
                else "restricted — tap to allow background sync",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            if (exempt) "✓" else "!",
            style = MaterialTheme.typography.labelLarge,
            color = if (exempt) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
        )
    }
}

/** P4: invite/join — paste a QR payload (relay invite or secure-join). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun JoinScreen(model: AppModel) {
    val checked = model.joinChecked
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Join") },
                navigationIcon = {
                    TextButton(onClick = { model.closeJoin() }) { Text("✕") }
                },
            )
        },
    ) { inner ->
        Column(
            modifier = Modifier.padding(inner).fillMaxSize().padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            OutlinedTextField(
                value = model.joinText,
                onValueChange = {
                    model.joinText = it
                    model.joinChecked = null
                },
                label = { Text("Invite code or QR text") },
                placeholder = { Text("DCACCOUNT:… or DCJOIN:…") },
                minLines = 2,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.size(12.dp))
            Button(
                onClick = { model.checkJoin() },
                enabled = !model.joinBusy && model.joinText.isNotBlank(),
            ) { Text("Check") }
            model.joinError?.let {
                Spacer(Modifier.size(8.dp))
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            if (checked != null) {
                Spacer(Modifier.size(16.dp))
                val summary = when {
                    checked.isAccountInvite -> "Relay invite for ${checked.domain ?: "?"} — sets up this app for that relay"
                    checked.isSecureJoin -> "Secure-join invite${checked.grpname?.let { " — $it" } ?: ""}"
                    checked.kind == "text" -> "Not a Delta Chat QR — just text"
                    else -> "QR of kind “${checked.kind}” — not supported here yet"
                }
                Text(summary, textAlign = TextAlign.Center)
                if (checked.isAccountInvite || checked.isSecureJoin) {
                    Spacer(Modifier.size(16.dp))
                    Button(
                        onClick = { model.join() },
                        enabled = !model.joinBusy,
                    ) { Text(if (checked.isAccountInvite) "Set up relay" else "Join") }
                }
            }
            if (model.joinBusy) {
                Spacer(Modifier.size(12.dp))
                Text("working…", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatListScreen(model: AppModel) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Velta")
                        Text(
                            listOfNotNull(model.accountAddr, "core ${model.coreVersion}").joinToString(" · "),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    if (model.chatsLoading) {
                        CircularProgressIndicator(Modifier.size(20.dp))
                        Spacer(Modifier.size(12.dp))
                    }
                    TextButton(onClick = { model.openRelays() }) { Text("⚡") }
                    TextButton(onClick = { model.openAccounts() }) { Text("👤") }
                    TextButton(onClick = { model.screen = AppModel.Screen.Join; model.joinChecked = null; model.joinError = null }) { Text("🎟") }
                    TextButton(onClick = { model.refreshChats() }) { Text("Refresh") }
                },
            )
        },
    ) { inner ->
        if (model.chats.isEmpty()) {
            Box(Modifier.padding(inner).fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    if (model.chatsLoading) "Loading…" else "No chats yet",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            LazyColumn(Modifier.padding(inner)) {
                items(model.chats, key = { it.id }) { item ->
                    ChatListRow(item) { model.openChat(item) }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun ChatListRow(item: ChatListItem, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(44.dp)
                .background(color = chatColor(item.color), shape = RoundedCornerShape(22.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text(item.name.take(1).uppercase(), fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.size(12.dp))
        Column(Modifier.weight(1f)) {
            Text(item.name, fontWeight = FontWeight.SemiBold)
            val summary = listOf(item.summaryText1, item.summaryText2)
                .filter { it.isNotBlank() }
                .joinToString(" ")
            if (summary.isNotBlank()) {
                Text(
                    summary,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
        }
        if (item.freshMessageCounter > 0) {
            Badge { Text(item.freshMessageCounter.toString()) }
        }
    }
}

/** Parse the core's "#rrggbb" chat color; falls back to a slate blue. */
private fun chatColor(hex: String?): androidx.compose.ui.graphics.Color {
    val rgb = hex?.removePrefix("#")?.toLongOrNull(16)
    val argb = if (rgb != null) (0xFF000000L or rgb) else 0xFF335577L
    return androidx.compose.ui.graphics.Color(argb)
}

/** One row of the chat view: a day separator or a message. */
private sealed interface ChatRow {
    val key: String

    data class Header(val text: String) : ChatRow {
        override val key: String get() = "h:$text"
    }

    data class Message(val message: MessageObject) : ChatRow {
        override val key: String get() = "m:${message.id}"
    }
}

private val FLAG_ON = androidx.compose.ui.graphics.Color(0xFF2ECC71)
private val FLAG_OFF = androidx.compose.ui.graphics.Color(0xFF9AA0A6)

/** P4 slice 2: relay cards — one card per configured transport (issue #192). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RelaysScreen(model: AppModel) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Relays") },
                navigationIcon = {
                    TextButton(onClick = { model.backFromRelays() }) { Text("‹ Back") }
                },
                actions = {
                    if (model.relaysLoading) CircularProgressIndicator(Modifier.size(20.dp))
                    Spacer(Modifier.size(12.dp))
                },
            )
        },
    ) { inner ->
        if (model.relays.isEmpty()) {
            Box(Modifier.padding(inner).fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    if (model.relaysLoading) "Loading…" else "No relays yet",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            LazyColumn(Modifier.padding(inner)) {
                items(model.relays, key = { it.addr }) { card ->
                    RelayCardItem(card) { model.removeRelay(card.addr) }
                    HorizontalDivider()
                }
                item {
                    Text(
                        "C calls · I iroh · P push · D instant delivery — grey means the relay does not advertise it (or it is not known yet)",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun RelayCardItem(card: org.velta.kmp.core.RelayCard, onRemove: () -> Unit) {
    val meta = card.metadata
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                card.addr,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.weight(1f),
            )
            RelayFlag("C", meta?.hasTurn == true)
            RelayFlag("I", meta?.irohRelay != null)
            RelayFlag("P", meta?.supportsPush == true)
            RelayFlag("D", meta?.canIdle) // tri-state: null = not known yet
        }
        val details = buildList {
            meta?.comment?.trim()?.takeIf { it.isNotEmpty() }?.let { add(it) }
            meta?.admin?.trim()?.takeIf { it.isNotEmpty() }?.let { add("Admin: $it") }
            val rcpt = meta?.maxSmtpRcptTo
            if (rcpt != null && rcpt > 0) add("Up to $rcpt recipients per message")
            if (meta?.canCompress == true) add("compressed connection")
        }
        details.forEach { line ->
            Text(
                line,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onRemove) {
                Text("Remove", color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@Composable
private fun RelayFlag(letter: String, on: Boolean?) {
    val color = if (on == true) FLAG_ON else FLAG_OFF
    Text(
        letter,
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.Bold,
        color = color,
        modifier = Modifier
            .padding(start = 6.dp)
            .background(color.copy(alpha = 0.15f), RoundedCornerShape(6.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatScreen(model: AppModel, chat: AppModel.Screen.Chat) {
    val listState = rememberLazyListState()
    LaunchedEffect(model.chatMessages.size) {
        if (model.chatMessages.isNotEmpty()) {
            listState.animateScrollToItem(chatRows(model.chatMessages).size - 1)
        }
    }

    // System back (Android) returns to the chat list; desktop uses ‹ Back.
    PlatformBackHandler {
        model.backToChatList()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(chat.title) },
                navigationIcon = {
                    TextButton(onClick = { model.backToChatList() }) { Text("‹ Back") }
                },
                actions = {
                    if (model.chatLoading) CircularProgressIndicator(Modifier.size(20.dp))
                    Spacer(Modifier.size(12.dp))
                },
            )
        },
        bottomBar = {
            Column {
                MessageActionBar(model)
                Composer(model)
            }
        },
    ) { inner ->
        val rows = chatRows(model.chatMessages)
        LazyColumn(
            modifier = Modifier.padding(inner).fillMaxSize(),
            state = listState,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 12.dp, horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(rows, key = { it.key }) { row ->
                when (row) {
                    is ChatRow.Header -> DayHeader(row.text)
                    is ChatRow.Message -> MessageBubble(
                        message = row.message,
                        senderName = if (chat.isGroup) model.senderNames[row.message.fromId] else null,
                        onTap = { model.toggleMessageActions(row.message) },
                    )
                }
            }
        }
    }
}

/** Group messages by local calendar date, inserting a header where the day changes. */
private fun chatRows(messages: List<MessageObject>): List<ChatRow> {
    val rows = mutableListOf<ChatRow>()
    var lastDay: String? = null
    for (message in messages) {
        val day = formatDateHeader(message.timestamp)
        if (day != lastDay) {
            rows += ChatRow.Header(day)
            lastDay = day
        }
        rows += ChatRow.Message(message)
    }
    return rows
}

@Composable
private fun DayHeader(text: String) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Text(
            text,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .background(
                    MaterialTheme.colorScheme.surfaceVariant,
                    RoundedCornerShape(10.dp),
                )
                .padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

private fun viewTypeGlyph(viewType: String): String = when (viewType) {
    "Image" -> "📷"
    "Gif" -> "🖼"
    "Video" -> "🎞"
    "Sticker" -> "✨"
    "Audio" -> "🎵"
    "Voice" -> "🎤"
    "File" -> "📎"
    "Webxdc" -> "🌐"
    else -> "📎"
}

/** Outgoing delivery state (core/src/message.rs): 20 pending, 24 failed, 26 delivered, 28 read. */
private fun stateGlyph(state: Int): String? = when (state) {
    20 -> "⏳"
    24 -> "⚠️"
    26 -> "✓"
    28 -> "✓✓"
    else -> null
}

private val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "😮", "😢", "🙏")

/** Tapping a bubble opens this bar: quick reactions + reply. */
@Composable
private fun MessageActionBar(model: AppModel) {
    val message = model.messageActions ?: return
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 4.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        QUICK_REACTIONS.forEach { emoji ->
            TextButton(onClick = { model.react(message, emoji) }) { Text(emoji) }
        }
        Spacer(Modifier.weight(1f))
        TextButton(onClick = { model.startReply(message) }) { Text("↩ Reply") }
        TextButton(onClick = { model.toggleMessageActions(message) }) { Text("✕") }
    }
}

@Composable
private fun Composer(model: AppModel) {
    val reply = model.replyTo
    val attachment = model.pendingAttachment
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
        if (reply != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "↩ ${reply.text.take(60)}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                )
                TextButton(onClick = { model.replyTo = null }) { Text("✕") }
            }
        }
        if (attachment != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "📎 ${attachment.second}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                )
                TextButton(onClick = { model.pendingAttachment = null }) { Text("✕") }
            }
        }
        model.sendError?.let {
            Text(
                "send failed: $it",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.labelSmall,
            )
        }
        Row(verticalAlignment = Alignment.Bottom) {
            TextButton(onClick = { model.attach() }) { Text("📎") }
            OutlinedTextField(
                value = model.composerText,
                onValueChange = { model.composerText = it },
                placeholder = { Text("Message") },
                modifier = Modifier.weight(1f),
                maxLines = 4,
            )
            Spacer(Modifier.size(8.dp))
            Button(
                onClick = { model.send() },
                enabled = !model.sending &&
                    (model.composerText.isNotBlank() || model.pendingAttachment != null),
            ) {
                Text(if (model.sending) "…" else "Send")
            }
        }
    }
}

private val MEDIA_VIEWTYPES = setOf("Image", "Gif", "Sticker")

@Composable
private fun MessageBubble(message: MessageObject, senderName: String?, onTap: () -> Unit) {
    val outgoing = message.fromId == 1L // ContactId.SELF
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start,
    ) {
        Column(horizontalAlignment = if (outgoing) Alignment.End else Alignment.Start) {
            if (!outgoing && senderName != null) {
                Text(
                    senderName,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(start = 12.dp, bottom = 1.dp),
                )
            }
            Surface(
                color = if (outgoing) {
                    MaterialTheme.colorScheme.primaryContainer
                } else {
                    MaterialTheme.colorScheme.surfaceVariant
                },
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier
                    .widthIn(max = 420.dp)
                    .heightIn(min = 20.dp)
                    .clickable(onClick = onTap),
            ) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                val mediaShown = message.viewType in MEDIA_VIEWTYPES && message.file != null
                if (mediaShown) {
                    MediaFromDisk(message.file!!)
                } else if (message.viewType != "Text") {
                    Text(
                        "${viewTypeGlyph(message.viewType)} ${message.viewType}",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                    if (message.text.isNotBlank()) {
                        Text(message.text, style = MaterialTheme.typography.bodyMedium)
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.align(Alignment.End),
                    ) {
                        Text(
                            formatTimestamp(message.timestamp),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (outgoing) {
                            stateGlyph(message.state)?.let { glyph ->
                                Spacer(Modifier.size(4.dp))
                                Text(
                                    glyph,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
            // Reaction summary under the bubble: emoji + count.
            val reactions = reactionSummary(message.reactions)
            if (reactions.isNotEmpty()) {
                Spacer(Modifier.size(2.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    reactions.forEach { (emoji, count) ->
                        Text(
                            if (count > 1) "$emoji $count" else emoji,
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier
                                .background(
                                    MaterialTheme.colorScheme.surfaceVariant,
                                    RoundedCornerShape(10.dp),
                                )
                                .padding(horizontal = 8.dp, vertical = 2.dp),
                        )
                    }
                }
            }
        }
    }
}

/** Aggregate the core's `Reactions` object into emoji → count pairs. */
private fun reactionSummary(reactions: kotlinx.serialization.json.JsonElement?): List<Pair<String, Int>> {
    val byReaction = (reactions as? kotlinx.serialization.json.JsonObject)
        ?.get("contactsByReaction") as? kotlinx.serialization.json.JsonObject
        ?: return emptyList()
    return byReaction.map { (emoji, contacts) ->
        emoji to ((contacts as? kotlinx.serialization.json.JsonArray)?.size ?: 0)
    }
}
