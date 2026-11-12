package org.velta.kmp.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.window.Popup
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.Image
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.IconButton
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.TextStyle
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.jetbrains.compose.resources.painterResource
import org.velta.kmp.generated.resources.Res
import org.velta.kmp.generated.resources.v_logo
import kotlin.math.roundToInt

/** P1 read-path UI: login, chat list, chat view. Bare bones by design (issue #192). */
@Composable
fun App(model: AppModel) {
    val systemDark = isSystemInDarkTheme()
    VeltaTheme(
        mode = veltaEffectiveMode(model.themeChoice, model.amoled, systemDark),
        accentHex = model.accentHex,
    ) {
        Surface(modifier = Modifier.fillMaxSize()) {
            if (model.locked) {
                LockScreen(model)
            } else {
                when (val current = model.screen) {
                    AppModel.Screen.Login -> JoinScreen(model, welcome = true)
                    AppModel.Screen.ChatList -> ChatListScreen(model)
                    AppModel.Screen.Relays -> RelaysScreen(model)
                    AppModel.Screen.Settings -> SettingsScreen(model)
                    AppModel.Screen.Accounts -> AccountsScreen(model)
                    AppModel.Screen.Settings -> SettingsScreen(model)
                    AppModel.Screen.Join -> JoinScreen(model)
                    is AppModel.Screen.Chat -> ChatScreen(model, current)
                    is AppModel.Screen.Profile -> ProfileScreen(model, current)
                }
            }
        }
    }
}

/** P4 phase-4 port: blocks the whole app until the unlock prompt succeeds. */
@Composable
private fun LockScreen(model: AppModel) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Velta", style = MaterialTheme.typography.displaySmall)
        Spacer(Modifier.size(8.dp))
        Text(
            "Locked — the database stays encrypted until you unlock",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.size(24.dp))
        Button(onClick = { model.requestUnlock?.invoke() }) { Text(L.t("Unlock")) }
    }
}


/** P4: account switcher — the core persists the selected account across restarts. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AccountsScreen(model: AppModel) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(L.t("Accounts")) },
                navigationIcon = {
                    TextButton(onClick = { model.backFromAccounts() }) { Icon(VeltaIcons.chevronLeft, contentDescription = L.t("Back"), modifier = Modifier.size(26.dp), tint = Velta.tokens.textDim) }
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
                        .clickable(enabled = account.configured) {
                            if (!current) model.switchAccount(account.id)
                        }
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            account.displayName?.takeIf { it.isNotBlank() }
                                ?: account.addr?.takeIf { it.isNotBlank() }
                                ?: if (account.configured) "Account ${account.id}" else "Not set up",
                            fontWeight = if (current) FontWeight.Bold else FontWeight.Normal,
                        )
                        if (!account.configured) {
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
                ) { Icon(VeltaIcons.plus, contentDescription = null, modifier = Modifier.size(18.dp)); Spacer(Modifier.size(6.dp)); Text(L.t("Add account")) }
            }
            item {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { model.screen = AppModel.Screen.Settings }
                        .padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(L.t("Settings"), modifier = Modifier.weight(1f))
                    Icon(VeltaIcons.chevronRight, contentDescription = null, modifier = Modifier.size(20.dp), tint = Velta.tokens.textDim)
                }
            }
            item {
                BatteryRow(model)
            }
            item {
                AppLockRow(model)
            }
        }
    }
}

/** P4 phase-4 port: enable/disable the app lock (prompt runs per tap). */
@Composable
private fun AppLockRow(model: AppModel) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable {
                if (model.appLockOn) model.requestAppLockDisable?.invoke()
                else model.requestAppLockEnable?.invoke()
            }
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("App lock")
            Text(
                if (model.appLockOn) "on — unlock required at start"
                else "off — tap to lock the database behind your screen lock",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Icon(
            if (model.appLockOn) VeltaIcons.lock else VeltaIcons.lockOpen,
            contentDescription = if (model.appLockOn) "App lock on" else "App lock off",
            modifier = Modifier.size(18.dp),
        )
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
        Icon(
            if (exempt) VeltaIcons.tick1 else VeltaIcons.warn,
            contentDescription = if (exempt) "Battery exempt" else "Battery restricted",
            modifier = Modifier.size(18.dp),
            tint = if (exempt) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
        )
    }
}

/** P4: invite/join — paste or scan a QR payload (relay invite, relay
 * sign-in, or secure-join). With `welcome` it doubles as the first-run
 * onboarding screen (no account yet — nothing to close). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun JoinScreen(model: AppModel, welcome: Boolean = false) {
    val checked = model.joinChecked
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (welcome) L.t("Welcome to Velta") else L.t("Join")) },
                navigationIcon = {
                    if (!welcome) {
                        TextButton(onClick = { model.closeJoin() }) { Icon(VeltaIcons.close, contentDescription = L.t("Close")) }
                    }
                },
            )
        },
    ) { inner ->
        Column(
            modifier = Modifier.padding(inner).fillMaxSize().padding(24.dp),
            verticalArrangement = if (welcome) Arrangement.Top else Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (welcome) {
                Spacer(Modifier.size(24.dp))
                Text("Velta", style = MaterialTheme.typography.displaySmall)
                Text(
                    "KMP client · core ${model.coreVersion} · ${model.status}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.size(24.dp))
                Text(
                    "Paste a relay invite (DCACCOUNT:…), a relay sign-in code " +
                        "(DCLOGIN:…), or a secure-join invite — or scan one.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.size(24.dp))
            }
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
            if (model.requestQrScan != null) {
                Spacer(Modifier.size(8.dp))
                TextButton(onClick = { model.requestQrScan?.invoke() }) { Icon(VeltaIcons.camera, contentDescription = null, modifier = Modifier.size(18.dp)); Spacer(Modifier.size(6.dp)); Text("Scan a QR instead") }
            }
            model.joinError?.let {
                Spacer(Modifier.size(8.dp))
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            if (checked != null) {
                Spacer(Modifier.size(16.dp))
                val summary = when {
                    checked.isAccountInvite -> "Relay invite for ${checked.domain ?: "?"} — sets up this app for that relay"
                    checked.isLoginInvite -> "Sign-in code for ${checked.domain ?: "?"} — sets up this app with that account"
                    checked.isSecureJoin -> "Secure-join invite${checked.grpname?.let { " — $it" } ?: ""}"
                    checked.kind == "text" -> "Not a Delta Chat QR — just text"
                    else -> "QR of kind “${checked.kind}” — not supported here yet"
                }
                Text(summary, textAlign = TextAlign.Center)
                if (checked.isAccountInvite || checked.isLoginInvite || checked.isSecureJoin) {
                    Spacer(Modifier.size(16.dp))
                    Button(
                        onClick = { model.join() },
                        enabled = !model.joinBusy,
                    ) {
                        Text(
                            when {
                                checked.isAccountInvite -> "Set up relay"
                                checked.isLoginInvite -> "Sign in"
                                else -> L.t("Join")
                            },
                        )
                    }
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
    var menuOpen by remember { mutableStateOf(false) }
    var searching by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val shown = if (query.isBlank()) model.chats else model.chats.filter { chat ->
        val q = query.trim()
        chat.name.contains(q, ignoreCase = true) ||
            chat.summaryText1.contains(q, ignoreCase = true) ||
            chat.summaryText2.contains(q, ignoreCase = true)
    }
    var headPx by remember { mutableIntStateOf(0) }
    val headDp = with(LocalDensity.current) { headPx.toDp() }
    GlassHost(
        Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.navigationBars),
        content = {
        if (shown.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(top = headDp), contentAlignment = Alignment.Center) {
                Text(
                    when {
                        model.chatsLoading -> L.t("Loading…")
                        query.isNotBlank() -> "No matches"
                        else -> "No chats yet"
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            LazyColumn(contentPadding = PaddingValues(top = headDp)) {
                items(shown, key = { it.id }) { item ->
                    ChatListRow(item, model.identities[item.id]) { model.openChat(item) }
                    HorizontalDivider()
                }
            }
        }
        },
        overlay = { backdrop, host ->
            GlassPlate(
                backdrop,
                host,
                Modifier.fillMaxWidth().onSizeChanged { headPx = it.height },
                radius = 0.dp,
            ) {
            Column(Modifier.fillMaxWidth()) {
                Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
                Box(Modifier.fillMaxWidth().height(56.dp), contentAlignment = Alignment.Center) {
                    Image(
                        painterResource(Res.drawable.v_logo),
                        contentDescription = null,
                        modifier = Modifier.height(38.dp),
                        contentScale = ContentScale.Fit,
                    )
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box {
                            IconButton(
                                onClick = { menuOpen = true },
                                modifier = Modifier.semantics { contentDescription = L.t("Menu") },
                            ) { MenuMark() }
                            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                DropdownMenuItem(
                                    text = { Text(L.t("Settings")) },
                                    onClick = { menuOpen = false; model.openSettings() },
                                )
                                DropdownMenuItem(
                                    text = { Text(L.t("Relays")) },
                                    onClick = { menuOpen = false; model.openRelays() },
                                )
                                DropdownMenuItem(
                                    text = { Text(L.t("Accounts")) },
                                    onClick = { menuOpen = false; model.openAccounts() },
                                )
                                DropdownMenuItem(
                                    text = { Text("Invite") },
                                    onClick = {
                                        menuOpen = false
                                        model.joinChecked = null
                                        model.joinError = null
                                        model.screen = AppModel.Screen.Join
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text("Refresh") },
                                    onClick = { menuOpen = false; model.refreshChats() },
                                )
                            }
                        }
                        Spacer(Modifier.weight(1f))
                        if (model.chatsLoading) {
                            CircularProgressIndicator(Modifier.size(18.dp))
                        }
                        IconButton(
                            onClick = {
                                searching = !searching
                                if (!searching) query = ""
                            },
                            modifier = Modifier.semantics { contentDescription = L.t("Search chats") },
                        ) { SearchMark() }
                    }
                }
                RelayLine(model)
                if (searching) {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                        singleLine = true,
                        placeholder = { Text(L.t("Search chats")) },
                    )
                }
            }
            }
        },
    )
}

/** One segment per relay, colored by the account connectivity. Tap opens the relays screen. */
@Composable
private fun RelayLine(model: AppModel) {
    val color = when (relayBarState(model.relayConnectivity)) {
        "ok" -> RELAY_OK
        "down" -> RELAY_DOWN
        else -> RELAY_WAIT
    }
    val count = model.relays.size.coerceAtLeast(1)
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { model.openRelays() }
            .padding(vertical = 10.dp)
            .height(6.dp)
            .semantics { contentDescription = "Relay status" },
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        repeat(count) {
            Box(Modifier.weight(1f).fillMaxHeight().background(color))
        }
    }
}

/** Web renderRelayLine's account-wide color. 4000 connected, 2000–3999 connecting, below that down. */
internal fun relayBarState(connectivity: Int?): String = when {
    connectivity == null -> "connecting"
    connectivity >= 4000 -> "ok"
    connectivity >= 2000 -> "connecting"
    else -> "down"
}

@Composable
private fun MenuMark() {
    val color = LocalContentColor.current
    Canvas(Modifier.size(22.dp)) {
        val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round)
        listOf(0.28f, 0.5f, 0.72f).forEach { y ->
            drawLine(color, Offset(2.dp.toPx(), size.height * y), Offset(size.width - 2.dp.toPx(), size.height * y), stroke.width, stroke.cap)
        }
    }
}

@Composable
private fun SearchMark() {
    val color = LocalContentColor.current
    Canvas(Modifier.size(22.dp)) {
        val r = size.minDimension * 0.28f
        val c = Offset(size.width * 0.42f, size.height * 0.42f)
        drawCircle(color, r, c, style = Stroke(width = 2.dp.toPx()))
        drawLine(
            color,
            Offset(c.x + r * 0.7f, c.y + r * 0.7f),
            Offset(size.width * 0.82f, size.height * 0.82f),
            strokeWidth = 2.dp.toPx(),
            cap = StrokeCap.Round,
        )
    }
}

@Composable
private fun ChatListRow(item: ChatListItem, identityFpr: String?, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 1:1 peers with a key wear the fingerprint identity matrix (web
        // avatar.js); a chat photo (avatarPath) the decoded image; everything
        // else the Prism initials tile.
        val cells = identityFpr?.let { identityCells(it) }
        val photo = item.avatarPath?.takeIf { it.isNotBlank() }
        val photoBitmap = photo?.let { path -> remember(path) { decodeImage(path) } }
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(if (cells != null) 10.dp else 24.dp))
                .background(
                    color = if (cells == null && photoBitmap == null) prismTileColor(item.name)
                    else androidx.compose.ui.graphics.Color.Transparent,
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (photoBitmap != null) {
                Image(
                    photoBitmap,
                    contentDescription = null,
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Crop,
                )
            } else if (cells != null) {
                Column(Modifier.fillMaxSize()) {
                    listOf(0..2, 3..4, 5..6, 7..9).forEach { range ->
                        Row(Modifier.weight(1f)) {
                            range.forEach { i ->
                                val (_, rgb) = cells[i]
                                Box(
                                    Modifier
                                        .weight(1f)
                                        .fillMaxHeight()
                                        .background(
                                            color = androidx.compose.ui.graphics.Color(
                                                rgb[0], rgb[1], rgb[2],
                                            ),
                                        ),
                                )
                            }
                        }
                    }
                }
            } else {
                Text(prismInitials(item.name), fontWeight = FontWeight.Bold)
            }
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
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                item.lastUpdated?.let { formatTimestamp(it) } ?: "",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (item.isMuted) {
                    Icon(VeltaIcons.mute, contentDescription = L.t("Muted"), modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (item.isPinned) {
                    Icon(VeltaIcons.pin, contentDescription = L.t("Pinned"), modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (item.freshMessageCounter > 0) {
                    Badge { Text(item.freshMessageCounter.toString()) }
                }
            }
        }
    }
}

/** Prism avatar fill (web parity): the person color, darkened for 3:1 initials. */
private fun prismTileColor(name: String): androidx.compose.ui.graphics.Color {
    val c = prismFill(name)
    return androidx.compose.ui.graphics.Color(c[0], c[1], c[2])
}

/** Prism sender color: the person color nudged to read on the bubble surface. */
private fun prismSenderColor(name: String, bg: androidx.compose.ui.graphics.Color): androidx.compose.ui.graphics.Color {
    val bgRgb = intArrayOf(
        (bg.red * 255.0).roundToInt(),
        (bg.green * 255.0).roundToInt(),
        (bg.blue * 255.0).roundToInt(),
    )
    val c = prismSender(name, bgRgb)
    return androidx.compose.ui.graphics.Color(c[0], c[1], c[2])
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
private val RELAY_OK = androidx.compose.ui.graphics.Color(0xFF2ECC71)
private val RELAY_WAIT = androidx.compose.ui.graphics.Color(0xFFE6A23C)
private val RELAY_DOWN = androidx.compose.ui.graphics.Color(0xFFE05252)

/** #321 step 5: the web drawer's Settings section as a screen — theme
 * (auto/dark/light/brutal radios), the "Pure black (AMOLED)" flag (dark
 * only, app.js applyTheme), the accent presets + custom hex
 * (chat-appearance.js), and the language (native names, i18n.js LANGS).
 * Unlike the web everything applies live — no reload. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsScreen(model: AppModel) {
    val systemDark = isSystemInDarkTheme()
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(L.t("Settings")) },
                navigationIcon = {
                    TextButton(onClick = { model.backFromSettings() }) {
                        Icon(VeltaIcons.chevronLeft, contentDescription = L.t("Back"), modifier = Modifier.size(26.dp), tint = Velta.tokens.textDim)
                    }
                },
            )
        },
    ) { inner ->
        Column(
            Modifier
                .padding(inner)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            SettingsSection(L.t("Theme"))
            VeltaThemeChoice.entries.forEach { c ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { model.onSetTheme(c) }
                        .padding(vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = model.themeChoice == c, onClick = { model.onSetTheme(c) })
                    Text(
                        when (c) {
                            VeltaThemeChoice.Auto -> L.t("Auto")
                            VeltaThemeChoice.Dark -> L.t("Dark")
                            VeltaThemeChoice.Light -> L.t("Light")
                            VeltaThemeChoice.Brutal -> L.t("Brutal")
                        },
                    )
                }
            }
            // The web shows the AMOLED switch only while the effective theme
            // is dark (ui.js:1406); visible-in-light would silently do nothing.
            if (veltaEffectiveMode(model.themeChoice, amoled = false, systemDark = systemDark) == VeltaThemeMode.Dark) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { model.onSetAmoled(!model.amoled) }
                        .padding(vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(checked = model.amoled, onCheckedChange = { model.onSetAmoled(it) })
                    Text(L.t("Pure black (AMOLED)"))
                }
            }
            SettingsSection(L.t("Accent color"))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Accent.PRESETS.forEach { preset ->
                    val selected = model.accentHex == preset
                    Box(
                        modifier = Modifier
                            .size(34.dp)
                            .clip(CircleShape)
                            .background(preset?.let { Accent.toColor(it) } ?: Velta.tokens.accent)
                            .border(
                                if (selected) 2.dp else 1.dp,
                                if (selected) Velta.tokens.text else Velta.tokens.border,
                                CircleShape,
                            )
                            .clickable { model.onSetAccent(preset) },
                    )
                }
            }
            var custom by remember { mutableStateOf(model.accentHex ?: "") }
            OutlinedTextField(
                value = custom,
                onValueChange = { v ->
                    custom = v
                    // Web <input type=color> applies on every change; the
                    // normHex gate only lets valid #rgb/#rrggbb through.
                    Accent.normHex(v)?.let { model.onSetAccent(it) }
                },
                label = { Text("#1fa69a") },
                singleLine = true,
                isError = custom.isNotBlank() && Accent.normHex(custom) == null,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
            SettingsSection(L.t("Language"))
            L.LANGS.forEach { (code, nativeName) ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { model.onSetLang(code) }
                        .padding(vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = model.lang == code, onClick = { model.onSetLang(code) })
                    Text(nativeName)
                }
            }
            Text(
                "Untranslated text stays in English.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}

@Composable
private fun SettingsSection(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = Velta.tokens.textDim,
        modifier = Modifier.padding(top = 16.dp, bottom = 4.dp),
    )
}

/** P4 slice 2: relay cards — one card per configured transport (issue #192). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RelaysScreen(model: AppModel) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(L.t("Relays")) },
                navigationIcon = {
                    TextButton(onClick = { model.backFromRelays() }) { Icon(VeltaIcons.chevronLeft, contentDescription = L.t("Back"), modifier = Modifier.size(26.dp), tint = Velta.tokens.textDim) }
                },
                actions = {
                    if (model.relaysLoading) CircularProgressIndicator(Modifier.size(20.dp))
                    Spacer(Modifier.size(12.dp))
                },
            )
        },
    ) { inner ->
        Column(Modifier.padding(inner)) {
            model.relaysNotice?.let { notice ->
                Text(
                    notice,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            if (model.relays.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        if (model.relaysLoading) L.t("Loading…") else "No relays yet",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyColumn {
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
                Text(L.t("Remove"), color = MaterialTheme.colorScheme.error)
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
    // Paging (#223): near the top (oldest end) fetch the page before the
    // loaded window; a prepend is compensated so the viewport stays anchored.
    val nearOlderEnd by remember {
        derivedStateOf { listState.firstVisibleItemIndex <= 4 }
    }
    LaunchedEffect(nearOlderEnd, model.hasMoreMessages) {
        if (nearOlderEnd && model.hasMoreMessages) model.loadOlderMessages()
    }
    // Quote-tap jump (#321 step 4): scroll when the quoted message is in
    // the loaded window; clear the request either way.
    LaunchedEffect(model.pendingJumpToId) {
        val wanted = model.pendingJumpToId ?: return@LaunchedEffect
        val rows = chatRows(model.chatMessages)
        val idx = rows.indexOfFirst { it is ChatRow.Message && it.message.id == wanted }
        if (idx >= 0) listState.animateScrollToItem(idx)
        model.pendingJumpToId = null
    }
    LaunchedEffect(model.chatMessages.size) {
        val rows = chatRows(model.chatMessages)
        if (rows.isEmpty()) return@LaunchedEffect
        val added = model.pendingPrependCount
        if (added > 0) {
            // The item the user was reading moved down by `added` — restore it.
            listState.scrollToItem(
                (listState.firstVisibleItemIndex + added).coerceAtMost(rows.size - 1),
                listState.firstVisibleItemScrollOffset,
            )
            model.pendingPrependCount = 0
        } else {
            // Follow only the newest message when the user is already at the
            // bottom — reading history must not be yanked.
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            if (lastVisible >= rows.size - 2) {
                listState.animateScrollToItem(rows.size - 1)
            }
        }
    }

    // System back (Android) returns to the chat list; desktop uses ‹ Back.
    PlatformBackHandler {
        model.backToChatList()
    }

    var headPx by remember { mutableIntStateOf(0) }
    var footPx by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current
    val lens = model.replyTo == null && model.pendingAttachment == null && model.messageActions == null
    GlassHost(
        Modifier.fillMaxSize().windowInsetsPadding(
            WindowInsets.ime.union(WindowInsets.navigationBars),
        ),
        content = {
        val rows = chatRows(model.chatMessages)
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = listState,
            contentPadding = PaddingValues(
                start = 12.dp,
                end = 12.dp,
                top = with(density) { headPx.toDp() } + 12.dp,
                bottom = with(density) { footPx.toDp() } + 12.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(rows, key = { it.key }) { row ->
                when (row) {
                    is ChatRow.Header -> DayHeader(row.text)
                    is ChatRow.Message -> MessageBubble(
                        message = row.message,
                        senderName = if (chat.isGroup) model.senderNames[row.message.fromId] else null,
                        members = model.chatMembers[chat.chatId] ?: emptyList(),
                        model = model,
                        onTap = { model.toggleMessageActions(row.message) },
                    )
                }
            }
        }
        },
        overlay = { backdrop, host ->
        GlassPlate(
            backdrop,
            host,
            Modifier.fillMaxWidth().onSizeChanged { headPx = it.height },
            radius = 0.dp,
        ) {
            Column(Modifier.fillMaxWidth()) {
            Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
            Row(
                Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = { model.backToChatList() }) { Icon(VeltaIcons.chevronLeft, contentDescription = L.t("Back"), modifier = Modifier.size(26.dp), tint = Velta.tokens.textDim) }
                Text(
                    chat.title,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    fontWeight = FontWeight.SemiBold,
                )
                if (!chat.isGroup) {
                    TextButton(onClick = { model.openProfile(chat.chatId, chat.title) }) { Icon(VeltaIcons.info, contentDescription = L.t("Info"), modifier = Modifier.size(24.dp), tint = Velta.tokens.textDim) }
                }
                if (model.chatLoading) CircularProgressIndicator(Modifier.size(20.dp))
                Spacer(Modifier.size(8.dp))
            }
            }
        }
        GlassPlate(
            backdrop,
            host,
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .onSizeChanged { footPx = it.height }
                .padding(
                    if (lens) PaddingValues(start = 10.dp, end = 10.dp, bottom = 8.dp)
                    else PaddingValues(0.dp),
                ),
            radius = if (lens) 22.dp else 0.dp,
            lens = lens,
        ) {
            Column {
                MessageActionBar(model)
                Composer(model)
            }
        }
        },
    )
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

private fun viewTypeIcon(viewType: String): ImageVector = when (viewType) {
    "Image", "Gif" -> VeltaIcons.photo
    "Video" -> VeltaIcons.video
    "Sticker" -> VeltaIcons.sticker
    "Audio", "Voice" -> VeltaIcons.mic
    "File" -> VeltaIcons.fileLarge
    "Webxdc" -> VeltaIcons.webxdc
    else -> VeltaIcons.attach
}

/** Outgoing delivery state (core/src/message.rs): 20 pending, 24 failed, 26 delivered, 28 read. */
private fun stateIcon(state: Int): ImageVector? = when (state) {
    20 -> VeltaIcons.clock
    24 -> VeltaIcons.warn
    26 -> VeltaIcons.tick1
    28 -> VeltaIcons.tick2
    else -> null
}

private val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "😮", "😢", "🙏")

/** "1 week" / "5 min" / "45 s" — the disappearing-timer value. */
private fun humantimeSecs(secs: Int): String = when {
    secs <= 0 -> L.t("Off")
    secs % 86400 == 0 -> "${secs / 86400} day${if (secs / 86400 > 1) "s" else ""}"
    secs % 3600 == 0 -> "${secs / 3600} hour${if (secs / 3600 > 1) "s" else ""}"
    secs % 60 == 0 -> "${secs / 60} min"
    else -> "$secs s"
}

/** "0E69 2C68 … 1009" / "3DD1 … BED9" — 5 groups of 4 per line.
 *  v4 keys are 40 hex (2 lines), v6 keys are 64 (4 lines). */
internal fun groupedFpr(fpr: String): String {
    val hex = fpr.filter { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }
    return hex.chunked(20).joinToString("\n") { it.chunked(4).joinToString(" ") }
}

/** The contact sheet (web profile screen): identity tiles, contact data,
 * actions. Any chat can open it; contact rows appear for 1:1 chats. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProfileScreen(model: AppModel, profile: AppModel.Screen.Profile) {
    PlatformBackHandler {
        model.backFromProfile()
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(L.t("Profile")) },
                navigationIcon = {
                    TextButton(onClick = { model.backFromProfile() }) { Icon(VeltaIcons.chevronLeft, contentDescription = L.t("Back"), modifier = Modifier.size(26.dp), tint = Velta.tokens.textDim) }
                },
            )
        },
    ) { inner ->
        val p = model.profile
        if (p == null) {
            Box(Modifier.padding(inner).fillMaxSize(), contentAlignment = Alignment.Center) {
                if (model.profileLoading) CircularProgressIndicator(Modifier.size(20.dp))
            }
            return@Scaffold
        }
        Column(
            Modifier
                .padding(inner)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.size(12.dp))
            // Avatar: identity matrix with its rounded corners; Prism tile
            // for key-less chats.
            val cells = p.fingerprint?.let { identityCells(it) }
            Box(
                modifier = Modifier
                    .size(120.dp)
                    .clip(RoundedCornerShape(if (cells != null) 26.dp else 60.dp))
                    .background(
                        color = if (cells == null) prismTileColor(p.contactName.ifEmpty { p.chatName })
                        else androidx.compose.ui.graphics.Color.Transparent,
                    ),
                contentAlignment = Alignment.Center,
            ) {
                if (cells != null) {
                    Column(Modifier.fillMaxSize()) {
                        listOf(0..2, 3..4, 5..6, 7..9).forEach { range ->
                            Row(Modifier.weight(1f)) {
                                range.forEach { i ->
                                    val (_, rgb) = cells[i]
                                    Box(
                                        Modifier
                                            .weight(1f)
                                            .fillMaxHeight()
                                            .background(
                                                color = androidx.compose.ui.graphics.Color(
                                                    rgb[0], rgb[1], rgb[2],
                                                ),
                                            ),
                                    )
                                }
                            }
                        }
                    }
                } else {
                    Text(
                        prismInitials(p.contactName.ifEmpty { p.chatName }),
                        fontSize = 42.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
            Spacer(Modifier.size(10.dp))
            Text(
                p.contactName.ifEmpty { p.chatName },
                fontSize = 18.sp,
                fontWeight = FontWeight.SemiBold,
            )
            if (p.addr.isNotEmpty()) {
                Text(
                    p.addr,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.size(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { model.backFromProfile() }) { Text(L.t("Send message")) }
                if (p.contactId != null) {
                    TextButton(onClick = { model.toggleBlockPeer() }) {
                        Text(
                            if (p.blocked) L.t("Unblock") else L.t("Block"),
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
            Spacer(Modifier.size(8.dp))
            HorizontalDivider()
            profileRows(p)
            Spacer(Modifier.size(24.dp))
        }
    }
}

/** The contact-sheet data rows (media counts, address, key, timers). */
@Composable
private fun profileRows(p: AppModel.ProfileData) {
    val rows = buildList {
        add("Apps" to p.apps.toString())
        add("Photos" to p.photos.toString())
        add("Videos" to p.videos.toString())
        add("Audio" to p.audio.toString())
        add("Files" to p.files.toString())
        if (p.addr.isNotEmpty()) add(L.t("Address") to p.addr)
        p.fingerprint?.let { add(L.t("Profile key") to groupedFpr(it)) }
        add(L.t("Last seen") to relativeLastSeen(p.lastSeenSeconds))
        add(L.t("Notifications") to if (p.muted) L.t("Off") else L.t("On"))
        add("Disappearing messages" to humantimeSecs(p.ephemeralSecs))
    }
    rows.forEach { (k, v) ->
        Row(
            Modifier
                .fillMaxWidth()
                .padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                k,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(0.4f),
            )
            Text(
                v,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(0.6f),
            )
        }
        HorizontalDivider()
    }
}

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
        TextButton(onClick = { model.startReply(message) }) { Icon(VeltaIcons.reply, contentDescription = null, modifier = Modifier.size(18.dp)); Spacer(Modifier.size(6.dp)); Text(L.t("Reply")) }
        TextButton(onClick = { model.toggleMessageActions(message) }) { Icon(VeltaIcons.close, contentDescription = L.t("Close")) }
    }
}

@Composable
private fun Composer(model: AppModel) {
    val reply = model.replyTo
    val attachment = model.pendingAttachment
    var showStickers by remember { mutableStateOf(false) }
    var showAttachMenu by remember { mutableStateOf(false) }
    if (showStickers) {
        StickerPicker(
            packs = model.stickerPacks,
            onPick = { path ->
                showStickers = false
                model.sendSticker(path)
            },
            onDismiss = { showStickers = false },
        )
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
        if (reply != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    VeltaIcons.reply,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    reply.text.take(60),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                )
                TextButton(onClick = { model.replyTo = null }) { Icon(VeltaIcons.close, contentDescription = L.t("Close")) }
            }
        }
        if (attachment != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    VeltaIcons.attach,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.size(6.dp))
                Text(
                    attachment.second,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                )
                TextButton(onClick = { model.pendingAttachment = null }) { Icon(VeltaIcons.close, contentDescription = L.t("Close")) }
            }
        }
        model.sendError?.let {
            Text(
                "send failed: $it",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.labelSmall,
            )
        }
        // Velta stable composer (app/index.html footer.composer): 48dp icon
        // buttons, a 48dp-min 16dp-radius input wrap on bgSidebar, no Material
        // chrome. Icons ride --ico-5 (26px); send is accentText when armed.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                IconButton(onClick = { showAttachMenu = !showAttachMenu }, modifier = Modifier.size(48.dp)) {
                    Icon(
                        VeltaIcons.attach,
                        contentDescription = L.t("Attach"),
                        modifier = Modifier.size(26.dp),
                        tint = Velta.tokens.textDim,
                    )
                }
                AttachMenu(
                    expanded = showAttachMenu,
                    stickersReady = true,
                    cameraAvailable = model.cameraCapture != null,
                    onDismiss = { showAttachMenu = false },
                    onPick = { kind ->
                        showAttachMenu = false
                        model.attach(kind)
                    },
                    onStickers = {
                        showAttachMenu = false
                        model.loadStickers()
                        showStickers = !showStickers
                    },
                    onCamera = {
                        showAttachMenu = false
                        model.cameraCapture?.invoke()
                    },
                )
            }
            Row(
                Modifier
                    .weight(1f)
                    .heightIn(min = 48.dp)
                    .background(Velta.tokens.bgSidebar, RoundedCornerShape(16.dp))
                    .border(1.dp, Velta.tokens.border, RoundedCornerShape(16.dp)),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BasicTextField(
                    value = model.composerText,
                    onValueChange = { model.composerText = it },
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = 16.dp, end = 6.dp, top = 13.dp, bottom = 13.dp),
                    textStyle = TextStyle(
                        fontSize = 15.5.sp,
                        lineHeight = (15.5f * 1.3f).sp,
                        color = Velta.tokens.text,
                    ),
                    cursorBrush = SolidColor(Velta.tokens.accent),
                    maxLines = 4,
                    decorationBox = { inner ->
                        Box {
                            if (model.composerText.isEmpty()) {
                                Text(
                                    L.t("Message"),
                                    style = TextStyle(
                                        fontSize = 15.5.sp,
                                        lineHeight = (15.5f * 1.3f).sp,
                                        color = Velta.tokens.textDim,
                                    ),
                                )
                            }
                            inner()
                        }
                    },
                )
            }
            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                IconButton(
                    onClick = { model.send() },
                    enabled = !model.sending &&
                        (model.composerText.isNotBlank() || model.pendingAttachment != null),
                    modifier = Modifier.size(48.dp),
                ) {
                    Icon(
                        VeltaIcons.send,
                        contentDescription = L.t("Send"),
                        modifier = Modifier.size(26.dp),
                        tint = if (model.sending || (model.composerText.isBlank() && model.pendingAttachment == null)) {
                            Velta.tokens.textDim
                        } else {
                            Velta.tokens.accentText
                        },
                    )
                }
            }
        }
    }
}

/**
 * Web attach menu (chat-view.js): Photo / Video / Camera / File / Stickers,
 * anchored to the attach button, growing upward.
 */
@Composable
private fun AttachMenu(
    expanded: Boolean,
    stickersReady: Boolean,
    cameraAvailable: Boolean,
    onDismiss: () -> Unit,
    onPick: (AppModel.AttachKind) -> Unit,
    onStickers: () -> Unit,
    onCamera: () -> Unit,
) {
    if (!expanded) return
    Popup(alignment = Alignment.BottomStart, offset = IntOffset(0, -240)) {
        Surface(
            color = Velta.tokens.bgSidebar,
            shape = RoundedCornerShape(14.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, Velta.tokens.border),
            shadowElevation = 6.dp,
        ) {
            Column(Modifier.width(220.dp).padding(vertical = 6.dp)) {
                AttachMenuItem(VeltaIcons.photo, L.t("Photo")) { onDismiss(); onPick(AppModel.AttachKind.PHOTO) }
                AttachMenuItem(VeltaIcons.video, L.t("Video")) { onDismiss(); onPick(AppModel.AttachKind.VIDEO) }
                if (cameraAvailable) {
                    AttachMenuItem(VeltaIcons.camera, L.t("Camera")) { onDismiss(); onCamera() }
                }
                AttachMenuItem(VeltaIcons.file, L.t("File")) { onDismiss(); onPick(AppModel.AttachKind.FILE) }
                if (stickersReady) {
                    AttachMenuItem(VeltaIcons.sticker, L.t("Stickers")) { onDismiss(); onStickers() }
                }
            }
        }
    }
}

@Composable
private fun AttachMenuItem(icon: ImageVector, label: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp), tint = Velta.tokens.textDim)
        Text(label, fontSize = 15.sp, color = Velta.tokens.text)
    }
}

/** Web .sticker-pop (ui.js): pack-named grid of sticker images; a tap sends. */
@Composable
private fun StickerPicker(
    packs: Map<String, List<String>>,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss) {
        Surface(
            color = Velta.tokens.bgSidebar,
            shape = RoundedCornerShape(14.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, Velta.tokens.border),
            modifier = Modifier.fillMaxWidth().padding(10.dp),
        ) {
            if (packs.isEmpty()) {
                Text(
                    L.t("No sticker packs installed"),
                    modifier = Modifier.padding(16.dp),
                    color = Velta.tokens.textDim,
                    fontSize = 14.sp,
                )
            } else {
                androidx.compose.foundation.lazy.LazyColumn(Modifier.heightIn(max = 420.dp)) {
                    packs.forEach { (pack, stickers) ->
                        item(key = pack) {
                            Text(
                                pack,
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 14.sp,
                                color = Velta.tokens.text,
                                modifier = Modifier.padding(start = 12.dp, top = 10.dp, bottom = 4.dp),
                            )
                        }
                        item(key = pack + "#grid") {
                            LazyVerticalGrid(
                                columns = GridCells.Fixed(4),
                                modifier = Modifier.heightIn(max = 200.dp),
                            ) {
                                items(stickers.size) { idx ->
                                    val path = stickers[idx]
                                    val bitmap = remember(path) { decodeImage(path) }
                                    Box(
                                        Modifier
                                            .padding(6.dp)
                                            .size(64.dp)
                                            .clickable { onPick(path) },
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        if (bitmap != null) {
                                            Image(
                                                bitmap,
                                                contentDescription = null,
                                                modifier = Modifier.size(64.dp),
                                                contentScale = ContentScale.Fit,
                                            )
                                        } else {
                                            Text("?", color = Velta.tokens.textDim)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Web .invite-card (invites.js): the whole card is the join button. */
@Composable
private fun InviteCard(url: String, onJoin: () -> Unit) {
    val dark = isSystemInDarkTheme()
    val bg = if (dark) Color(0x0FF4F4F4) else Color(0x0D101010)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 5.dp)
            .background(bg, RoundedCornerShape(10.dp))
            .border(1.dp, Velta.tokens.border, RoundedCornerShape(10.dp))
            .clickable(onClick = onJoin),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(start = 10.dp, end = 8.dp, top = 8.dp, bottom = 8.dp)) {
            Text(
                L.t("Join"),
                fontWeight = FontWeight.SemiBold,
                fontSize = 15.sp,
                lineHeight = (15f * 1.35f).sp,
                color = Velta.tokens.text,
            )
            Text(
                url,
                fontSize = 13.sp,
                color = Velta.tokens.textDim,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(
            VeltaIcons.chevronRight,
            contentDescription = null,
            modifier = Modifier.size(22.dp),
            tint = Velta.tokens.textDim,
        )
        Spacer(Modifier.size(10.dp))
    }
}

private val MEDIA_VIEWTYPES = setOf("Image", "Gif", "Sticker")

@Composable
private fun MessageBubble(
    message: MessageObject,
    senderName: String?,
    members: List<MentionMember>,
    model: AppModel,
    onTap: () -> Unit,
) {
    val outgoing = message.fromId == 1L // ContactId.SELF
    val clipboard = LocalClipboardManager.current
    val uriHandler = LocalUriHandler.current
    // .bubble CSS: radius 14px, the tail corner drops to 6px on the sender
    // side; padding 7px 10px 6px; 1px shadow; tokens bgBubbleIn/Out.
    val bubbleShape = RoundedCornerShape(
        topStart = 14.dp,
        topEnd = 14.dp,
        bottomStart = if (outgoing) 14.dp else 6.dp,
        bottomEnd = if (outgoing) 6.dp else 14.dp,
    )
    val dark = isSystemInDarkTheme()
    val quoteText = if (outgoing) Color(0xFFCFE0F2) else if (dark) Color(0xFF9AA3B5) else Color(0xFF4D5A68)
    val quoteName = if (outgoing) Color(0xFFD9E9FA) else Velta.tokens.accent
    val quoteBg = if (dark) Color(0x0FF4F4F4) else Color(0x0D101010)
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start,
    ) {
        Column(horizontalAlignment = if (outgoing) Alignment.End else Alignment.Start) {
            if (!outgoing && senderName != null) {
                Text(
                    senderName,
                    style = MaterialTheme.typography.labelSmall,
                    color = prismSenderColor(senderName, MaterialTheme.colorScheme.surfaceVariant),
                    modifier = Modifier.padding(start = 12.dp, bottom = 1.dp),
                )
            }
            Surface(
                color = if (outgoing) Velta.tokens.bgBubbleOut else Velta.tokens.bgBubbleIn,
                shape = bubbleShape,
                shadowElevation = 1.dp,
                modifier = Modifier
                    .widthIn(max = 420.dp)
                    .heightIn(min = 20.dp)
                    .clickable(onClick = onTap),
            ) {
            Column(Modifier.padding(start = 10.dp, end = 10.dp, top = 7.dp, bottom = 6.dp)) {
                // .msg-quote: 2.5dp accent bar, 6dp radius, name + one line.
                message.quote?.let { quote ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .height(IntrinsicSize.Min)
                            .padding(bottom = 5.dp)
                            .background(quoteBg, RoundedCornerShape(6.dp))
                            .clickable { model.jumpToQuoted(quote.messageId) },
                    ) {
                        Box(
                            Modifier
                                .width(2.5.dp)
                                .fillMaxHeight()
                                .background(Velta.tokens.accent),
                        )
                        val quoteImage = quote.image?.takeIf { it.isNotBlank() }
                            ?.let { path -> remember(path) { decodeImage(path) } }
                        if (quoteImage != null) {
                            Image(
                                quoteImage,
                                contentDescription = null,
                                modifier = Modifier
                                    .padding(start = 4.dp, top = 4.dp, bottom = 4.dp)
                                    .height(44.dp)
                                    .width(64.dp)
                                    .clip(RoundedCornerShape(4.dp)),
                                contentScale = ContentScale.Crop,
                            )
                        }
                        Column(Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
                            if (!quote.authorDisplayName.isNullOrBlank()) {
                                Text(
                                    quote.authorDisplayName,
                                    fontWeight = FontWeight.SemiBold,
                                    fontSize = 13.5.sp,
                                    color = quoteName,
                                    maxLines = 1,
                                )
                            }
                            Text(
                                quote.text.orEmpty(),
                                fontSize = 13.5.sp,
                                color = quoteText,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
                val mediaShown = message.viewType in MEDIA_VIEWTYPES && message.file != null
                if (mediaShown) {
                    MediaFromDisk(message.file!!)
                } else if (message.viewType != "Text") {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            viewTypeIcon(message.viewType),
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.size(6.dp))
                        Text(
                            message.viewType,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                    if (message.text.isNotBlank()) {
                        val annotated = markdownAnnotated(
                            message.text,
                            accent = if (outgoing) quoteName else Velta.tokens.accent,
                            codeBackground = quoteBg,
                            textColor = Velta.tokens.text,
                            members = members,
                        )
                        var textLayout by remember { mutableStateOf<TextLayoutResult?>(null) }
                        Text(
                            annotated,
                            fontSize = 15.5.sp,
                            lineHeight = (15.5f * 1.3f).sp,
                            onTextLayout = { textLayout = it },
                            modifier = Modifier.pointerInput(annotated) {
                                detectTapGestures { offset ->
                                    // Web semantics: code = click-to-copy,
                                    // links open, invites route to Join.
                                    val layout = textLayout ?: return@detectTapGestures
                                    val pos = layout.getOffsetForPosition(offset)
                                    for (a in annotated.getStringAnnotations(ANN_CODE, pos, pos)) {
                                        clipboard.setText(AnnotatedString(a.item))
                                        return@detectTapGestures
                                    }
                                    for (a in annotated.getStringAnnotations(ANN_INVITE, pos, pos)) {
                                        model.openInviteLink(a.item)
                                        return@detectTapGestures
                                    }
                                    for (a in annotated.getStringAnnotations(ANN_URL, pos, pos)) {
                                        // bindInviteInterception: an anchor
                                        // whose href parses as an invite
                                        // joins instead of opening the
                                        // browser (md-link invites stay
                                        // anchors — web's invite-card rule).
                                        val invite = parseInviteLink(a.item)
                                        if (invite != null) model.openInviteLink(invite)
                                        else runCatching { uriHandler.openUri(a.item) }
                                        return@detectTapGestures
                                    }
                                }
                            },
                        )
                        // Invite cards ride under the text like the web's
                        // inviteCardHtml: one card per INVITE annotation.
                        annotated.getStringAnnotations(ANN_INVITE, 0, annotated.length).forEach { a ->
                            InviteCard(a.item) { model.openInviteLink(a.item) }
                        }
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
                            stateIcon(message.state)?.let { glyph ->
                                Spacer(Modifier.size(4.dp))
                                Icon(
                                    glyph,
                                    contentDescription = null,
                                    modifier = Modifier.size(14.dp),
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
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
