package org.velta.kmp.ui

import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.systemGestures
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.window.Popup
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.isSecondaryPressed
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.input.pointer.positionChangeIgnoreConsumed
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
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
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
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
            } else if (model.contactPick != null) {
                PickContactsScreen(model)
            } else {
                when (val current = model.screen) {
                    AppModel.Screen.Login -> WelcomeScreen(model)
                    AppModel.Screen.ChatList -> ChatListScreen(model)
                    AppModel.Screen.Relays -> RelaysScreen(model)
                    AppModel.Screen.Settings -> SettingsScreen(model)
                    AppModel.Screen.Accounts -> AccountsScreen(model)
                    AppModel.Screen.Join -> JoinScreen(model)
                    is AppModel.Screen.Chat -> ChatBackHost(model, current)
                    is AppModel.Screen.Profile -> ProfileScreen(model, current)
                }
            }
            CreatedNotice(model)
            // #334 step 5: chat-list / ⋮ menus, their confirmations, group invite.
            if (!model.locked) ChatMenuHost(model)
            if (!model.locked && model.renameDraft != null) RenameChatDialog(model)
            if (!model.locked && model.ephemeralDraft != null) EphemeralDialog(model)
            if (!model.locked && model.batteryPromptOpen) BatteryPromptDialog(model)
            if (!model.locked && model.profileEditor != null) ProfileEditorDialog(model)
            if (!model.locked && model.secondDeviceOpen) SecondDeviceSheet(model)
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
            L.t("Database locked"),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        model.lockError?.let { err ->
            Spacer(Modifier.size(12.dp))
            Text(err, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
        }
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
                                ?: if (account.configured) L.t("Account {id}").replace("{id}", account.id.toString()) else L.t("Not set up"),
                            fontWeight = if (current) FontWeight.Bold else FontWeight.Normal,
                        )
                        if (!account.configured) {
                            Text(
                                L.t("not set up — sign in to configure"),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    if (current) {
                        Text(
                            L.t("current"),
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
            item { BackupRows(model) }
            item { ProxyRow(model) }
        }
    }
}

/** #334 step 11: this device offers a profile QR, or writes a backup tar. */
@Composable
private fun BackupRows(model: AppModel) {
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = !model.secondDeviceOpen) { model.startSecondDevice() }
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(L.t("Add as a second device…"), modifier = Modifier.weight(1f))
        }
        HorizontalDivider()
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = model.backupExportDir != null && !model.backupBusy) { model.exportBackup() }
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (model.backupBusy) L.t("Exporting…") else L.t("Export backup"),
                modifier = Modifier.weight(1f),
            )
        }
    }
}

/** #334 step 11: paste a velta://proxy link. One URL, every account. */
@Composable
private fun ProxyRow(model: AppModel) {
    var link by remember { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text(L.t("SOCKS5 proxy"))
        Text(
            if (model.proxyUrl.isNullOrBlank()) L.t("Not set up")
            else L.t("Mail goes through {name}.").replace("{name}", model.proxyLabel.ifBlank { model.proxyUrl ?: "" }),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = link,
            onValueChange = { link = it },
            singleLine = true,
            placeholder = { Text("velta://proxy") },
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        )
        Row {
            TextButton(onClick = { model.applyProxyLink(link) }, enabled = link.isNotBlank()) {
                Text(L.t("Add and use"))
            }
            if (!model.proxyUrl.isNullOrBlank()) {
                TextButton(onClick = { model.clearProxy() }) { Text(L.t("Turn off")) }
            }
        }
    }
}

@Composable
private fun SecondDeviceSheet(model: AppModel) {
    PlatformBackHandler { model.cancelSecondDevice() }
    Box(
        Modifier
            .fillMaxSize()
            .background(Velta.tokens.bg)
            .windowInsetsPadding(WindowInsets.statusBars)
            .padding(16.dp),
    ) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(L.t("Add as a second device…"), fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.size(12.dp))
            val qr = model.secondDeviceQr
            if (qr == null) {
                Text(L.t("Preparing QR…"))
            } else {
                BrandedQrSquare(qr)
                if (model.shareText != null) {
                    TextButton(onClick = { model.shareText?.invoke(qr) }) { Text(L.t("Share")) }
                }
            }
            model.transferPercent?.let {
                Text(L.t("Sending profile"), modifier = Modifier.padding(top = 8.dp))
            }
            Text(
                L.t("On the new device, tap \"Receive a profile on this device\" and scan or paste this code. Keep both devices on this screen until the transfer finishes."),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp),
            )
            model.secondDeviceError?.let {
                Text(
                    L.t("Couldn't prepare the transfer:") + " " + it,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            TextButton(onClick = { model.cancelSecondDevice() }, modifier = Modifier.padding(top = 8.dp)) {
                Text(L.t("Cancel"))
            }
        }
    }
}

@Composable
private fun RenameChatDialog(model: AppModel) {
    val initial = model.renameDraft ?: return
    var name by remember(initial) { mutableStateOf(initial) }
    VeltaDialog(
        title = L.t("Rename"),
        confirmLabel = L.t("Save"),
        confirmEnabled = groupName(name) != null,
        onConfirm = { model.commitRename(name) },
        onDismiss = { model.renameDraft = null },
    ) {
        OutlinedTextField(
            value = name,
            onValueChange = { name = it },
            singleLine = true,
            placeholder = { Text(L.t("Group name")) },
        )
    }
}

/** P4 phase-4 port: enable/disable the app lock (prompt runs per tap),
 * stable's "Lock when hidden" picker, and the last failure (#334). */
@Composable
private fun AppLockRow(model: AppModel) {
    Column(Modifier.fillMaxWidth()) {
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
                Text(L.t("App lock"))
                Text(
                    if (model.appLockOn) L.t("Biometric lock is on.") else L.t("Biometric lock is off."),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Icon(
                if (model.appLockOn) VeltaIcons.lock else VeltaIcons.lockOpen,
                contentDescription = L.t("App lock"),
                modifier = Modifier.size(18.dp),
            )
        }
        if (model.appLockOn) {
            var open by remember { mutableStateOf(false) }
            val label = { mins: Int ->
                when (mins) {
                    0 -> L.t("Off")
                    1 -> L.t("After 1 minute")
                    5 -> L.t("After 5 minutes")
                    else -> L.t("After 15 minutes")
                }
            }
            Box {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { open = true }
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(L.t("Lock when hidden"), modifier = Modifier.weight(1f))
                    Text(label(model.autoLockMins), color = MaterialTheme.colorScheme.primary)
                }
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    LockPolicy.AUTOLOCK_CHOICES.forEach { mins ->
                        DropdownMenuItem(
                            text = { Text(label(mins)) },
                            onClick = {
                                model.onSetAutoLock(mins)
                                open = false
                            },
                        )
                    }
                }
            }
        }
        model.lockError?.let { err ->
            Text(
                err,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
            )
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
            Text(L.t("Battery optimization"))
            Text(
                if (exempt) L.t("exempt — background sync survives battery savers")
                else L.t("restricted — tap to allow background sync"),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Icon(
            if (exempt) VeltaIcons.tick1 else VeltaIcons.warn,
            contentDescription = if (exempt) L.t("Battery exempt") else L.t("Battery restricted"),
            modifier = Modifier.size(18.dp),
            tint = if (exempt) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
        )
    }
}

/** P4: invite/join — paste or scan a QR payload (relay invite, relay
 * sign-in, or secure-join) once an account exists. First run is the
 * welcome splash (Welcome.kt, #334). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun JoinScreen(model: AppModel) {
    val checked = model.joinChecked
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(L.t("Join")) },
                navigationIcon = {
                    TextButton(onClick = { model.closeJoin() }) { Icon(VeltaIcons.close, contentDescription = L.t("Close")) }
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
                label = { Text(L.t("Invite link")) },
                placeholder = { Text("DCACCOUNT:… / https://i.delta.chat/#…") },
                minLines = 2,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.size(12.dp))
            Button(
                onClick = { model.checkJoin() },
                enabled = !model.joinBusy && model.joinText.isNotBlank(),
            ) { Text(L.t("Check")) }
            if (model.requestQrScan != null) {
                Spacer(Modifier.size(8.dp))
                TextButton(onClick = { model.requestQrScan?.invoke() }) { Icon(VeltaIcons.camera, contentDescription = null, modifier = Modifier.size(18.dp)); Spacer(Modifier.size(6.dp)); Text(L.t("Scan a QR code")) }
            }
            model.joinError?.let {
                Spacer(Modifier.size(8.dp))
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            if (checked != null) {
                Spacer(Modifier.size(16.dp))
                val host = checked.domain ?: "?"
                val summary = when {
                    // invite-cards.js: a dcaccount: link is an "Account invite".
                    checked.isAccountInvite -> L.t("Account invite: {host}").replace("{host}", host)
                    checked.isLoginInvite -> L.t("Sign-in code: {host}").replace("{host}", host)
                    checked.isSecureJoin && checked.grpname != null -> L.t("Join group") + " — " + checked.grpname
                    checked.isSecureJoin -> L.t("Velta invite")
                    checked.kind == "text" -> L.t("Not a Delta Chat QR — just text")
                    else -> L.t("That QR code isn't a Velta or Delta Chat invite")
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
                                checked.isAccountInvite -> L.t("Create an account on {host}").replace("{host}", host)
                                checked.isLoginInvite -> L.t("Sign in")
                                else -> L.t("Join")
                            },
                        )
                    }
                }
            }
            if (model.joinBusy) {
                Spacer(Modifier.size(12.dp))
                Text(L.t("Working…"), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatListScreen(model: AppModel, peek: Boolean = false) {
    var searchTab by remember { mutableStateOf("search") }
    var headPx by remember { mutableIntStateOf(0) }
    val headDp = with(LocalDensity.current) { headPx.toDp() }
    // Web pull-open (app.js:1446): pulling down at the top of the chats list
    // reveals the relay detail chips; they hide themselves after 4 seconds.
    var relayDetailShown by remember { mutableStateOf(false) }
    LaunchedEffect(relayDetailShown) {
        if (relayDetailShown) {
            kotlinx.coroutines.delay(4000)
            relayDetailShown = false
        }
    }
    // Android back inside a side view returns to the chats list first.
    PlatformBackHandler(enabled = !peek && model.listView != "chats") {
        model.toggleListView("chats")
    }
    GlassHost(
        Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.navigationBars),
        content = {
        Column(Modifier.fillMaxSize()) {
            Spacer(Modifier.height(headDp))
            // Views fill this Box, never the Column — the ListBar stays
            // pinned at the bottom (weight would let fillMaxSize eat it).
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (model.listView) {
                    "contacts" -> ContactsView(model)
                    "calls" -> CallsView(model)
                    "qr" -> QrView(model)
                    "new" -> NewChatView(model)
                    "search" -> SearchView(model, searchTab) { searchTab = it }
                    else -> ChatsView(model, onPullTop = { relayDetailShown = true }, onArchived = {
                        searchTab = "archived"
                        model.toggleListView("chats")
                    })
                }
            }
            ListBar(model)
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
                        // No menu button here: the web sidebar-head carries
                        // only the logo + search — the Menu lives in the
                        // list-bar at the bottom (index.html:77).
                        Spacer(Modifier.weight(1f))
                        if (model.chatsLoading) {
                            CircularProgressIndicator(Modifier.size(18.dp))
                        }
                        IconButton(
                            onClick = { model.toggleListView(if (model.listView == "search") "chats" else "search") },
                            modifier = Modifier.semantics { contentDescription = L.t("Search chats") },
                        ) {
                            if (model.listView == "search") {
                                Icon(VeltaIcons.close, contentDescription = L.t("Close"), modifier = Modifier.size(22.dp), tint = Velta.tokens.text)
                            } else {
                                SearchMark()
                            }
                        }
                    }
                }
                RelayZone(model, detailShown = relayDetailShown)
            }
            }
        },
    )
    GroupNameDialog(model)
    ChannelDialog(model)
}

/** The chats view: #57 category chips, sync strip, rows, archived link.
 *  [onPullTop] fires on a pull-down gesture while the list sits at the very
 *  top (web pull-open: reveals the relay detail chips). */
@Composable
private fun ChatsView(model: AppModel, onPullTop: () -> Unit, onArchived: () -> Unit) {
    LaunchedEffect(model.chatCategory, model.accountId) { model.ensureContactBots() }
    val listState = rememberLazyListState()
    // The two list-level gestures ride the CONTAINER, not the LazyColumn —
    // empty categories render the empty-state Box instead of a list, and the
    // swipes must keep working there (web: both handlers live on chatListEl).
    val gestures = Modifier
        .pointerInput(Unit) {
            // Web pull-open: pulling down at the very top reveals
            // the relay detail chips.
            awaitEachGesture {
                awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                // Only a pull from the absolute top counts (web
                // touchstart gate: scrollTop <= 0 — an unrendered list is
                // always at top, its state sits at the defaults).
                if (listState.firstVisibleItemIndex != 0 || listState.firstVisibleItemScrollOffset != 0) {
                    // Ride out the gesture without acting.
                    while (awaitPointerEvent(PointerEventPass.Initial).changes.any { it.pressed }) { /* draining */ }
                    return@awaitEachGesture
                }
                var pulled = 0f
                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    if (event.changes.none { it.pressed }) break
                    // Raw delta: the list's overscroll consumes the
                    // change, the pull gesture must still measure it.
                    pulled += event.changes.maxOf { it.positionChangeIgnoreConsumed().y }
                    if (pulled > 32.dp.toPx()) {
                        onPullTop()
                        break
                    }
                }
            }
        }
        .pointerInput(Unit) {
            // #57 follow-up (web app.js:1428-1440): a horizontal
            // swipe steps through the category chips — one step per
            // gesture, left = next, right = previous.
            if (!touchGesturesEnabled) return@pointerInput
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                val x0 = down.position.x
                val y0 = down.position.y
                var totalX = 0f
                var totalY = 0f
                var stepped = false
                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    if (event.changes.none { it.pressed }) break
                    if (stepped) continue // latch: one step per gesture
                    totalX += event.changes.maxOf { it.positionChangeIgnoreConsumed().x }
                    totalY += event.changes.maxOf { it.positionChangeIgnoreConsumed().y }
                    val step = swipeCategoryStep(totalX, totalY, 48.dp.toPx())
                    if (step != 0) {
                        stepped = true
                        val cats = AppModel.CHAT_CATEGORIES
                        val next = cats.getOrNull(cats.indexOf(model.chatCategory) + step)
                        if (next != null) model.onSetChatCategory(next)
                    }
                }
            }
        }
    Column(Modifier.fillMaxSize().then(gestures)) {
        CategoryChips(model)
        // Web renderSyncBar: the first-fetch strip — chats view, nothing real
        // in the list yet, core still working (connectivity < 4000).
        val connectivity = model.relayConnectivity
        if (model.chats.isEmpty() && connectivity != null && connectivity < 4000) {
            Text(
                L.t(if (connectivity >= 3000) "Updating…" else "Fetching messages…"),
                fontSize = 12.5.sp,
                color = Velta.tokens.textDim,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            )
        }
        val shown = model.chatsFor(model.chatCategory)
        val showArchivedLink = model.chatCategory == "all" && model.archivedChats.isNotEmpty()
        if (shown.isEmpty() && showArchivedLink) {
            // Web 2430: no chats but archived exist → the archived link alone.
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                ArchivedLinkRow(model.archivedChats.size, onArchived)
            }
        } else if (shown.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(
                    when {
                        model.chatsLoading -> L.t("Loading…")
                        model.chatCategory != "all" -> L.t("No chats in this category")
                        else -> L.t("No chats yet — start a new one")
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            LazyColumn(
                Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                state = listState,
            ) {
                items(shown, key = { it.id }) { item ->
                    ChatListRow(
                        item,
                        model.identities[item.id],
                        onMenu = { x, y -> model.openChatListMenu(item, x, y) },
                    ) { model.openChat(item) }
                    HorizontalDivider()
                }
                if (showArchivedLink) {
                    item(key = "archived-link") {
                        ArchivedLinkRow(model.archivedChats.size, onArchived)
                    }
                }
            }
        }
    }
}

/** #57 chip bar (web .chat-cats, index.html:47-55): equal-flex pills,
 * active = accent bg + on-accent ink, idle = bg-hover + dim ink. */
@Composable
private fun CategoryChips(model: AppModel) {
    Row(
        Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, top = 2.dp, bottom = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        AppModel.CHAT_CATEGORIES.forEach { cat ->
            val active = model.chatCategory == cat
            val interaction = remember { MutableInteractionSource() }
            Box(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(percent = 50))
                    .background(if (active) Velta.tokens.accent else Velta.tokens.bgHover)
                    .rowSurface(interaction, hover = false) // web chip hover changes ink, not surface
                    .clickable(interactionSource = interaction, indication = null) { model.onSetChatCategory(cat) }
                    .padding(horizontal = 2.dp, vertical = 5.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    L.t(
                        when (cat) {
                            "all" -> "All"
                            "unread" -> "Unread"
                            "people" -> "People"
                            "groups" -> "Groups"
                            "channels" -> "Channels"
                            "bots" -> "Bots"
                            else -> "System"
                        },
                    ),
                    fontSize = 11.5.sp,
                    lineHeight = 11.5.sp,
                    color = if (active) Velta.tokens.onAccentChip else Velta.tokens.textDim,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun ArchivedLinkRow(count: Int, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Row(
        Modifier
            .rowSurface(interaction)
            .fillMaxWidth()
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(48.dp), contentAlignment = Alignment.Center) {
            Icon(VeltaIcons.archive, contentDescription = null, modifier = Modifier.size(22.dp), tint = Velta.tokens.textDim)
        }
        Spacer(Modifier.size(10.dp))
        Text(L.t("Archived chats ({n})").replace("{n}", count.toString()), fontSize = 14.sp, color = Velta.tokens.textDim)
    }
}

/** Side view frame (web sideViewShell): title + sub + rows below the head. */
@Composable
private fun SideViewShell(title: String, subtitle: String, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxSize().padding(horizontal = 8.dp)) {
        Text(
            title,
            fontSize = 15.5.sp,
            fontWeight = FontWeight.SemiBold,
            color = Velta.tokens.text,
            modifier = Modifier.padding(start = 6.dp, top = 4.dp),
        )
        if (subtitle.isNotBlank()) {
            Text(
                subtitle,
                fontSize = 12.5.sp,
                color = Velta.tokens.textDim,
                modifier = Modifier.padding(start = 6.dp, bottom = 10.dp),
            )
        }
        content()
    }
}

@Composable
private fun SideViewEmpty(text: String) {
    Text(
        text,
        fontSize = 13.5.sp,
        color = Velta.tokens.textDim,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(vertical = 18.dp, horizontal = 6.dp),
    )
}

/** Contacts view (web renderContactsView): get_contacts rows; tap opens the chat. */
@Composable
private fun ContactsView(model: AppModel) {
    Column(Modifier.fillMaxSize()) {
        SideViewShell(L.t("Contacts"), L.t("Tap a contact to open the chat")) {
            KnownToggleRow(model)
            val shown = if (model.knownContactsOnly) {
                val known = model.knownContactIds()
                model.contacts.filter { it.id in known }
            } else {
                model.contacts
            }
            if (shown.isEmpty()) {
                SideViewEmpty(
                    if (model.contacts.isNotEmpty()) {
                        L.t("No known contacts yet — untick “Show only known contacts” above to see everyone.")
                    } else {
                        L.t("No contacts yet")
                    },
                )
            } else {
                LazyColumn(Modifier.weight(1f)) {
                    items(shown, key = { it.id }) { contact ->
                        ContactRow(contact) { model.openContactChat(contact) }
                    }
                }
            }
        }
    }
}

@Composable
private fun KnownToggleRow(model: AppModel) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable { model.onSetKnownContactsOnly(!model.knownContactsOnly) }
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = model.knownContactsOnly, onCheckedChange = { model.onSetKnownContactsOnly(it) })
        Text(L.t("Show only known contacts"), fontSize = 14.sp)
    }
}

@Composable
private fun ContactRow(contact: org.velta.kmp.core.Contact, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Row(
        Modifier
            .rowSurface(interaction)
            .fillMaxWidth()
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarTile(
            name = contact.displayName.ifBlank { contact.name.ifBlank { contact.address } },
            colorHex = contact.color,
            kind = null,
            size = 42.dp,
            avatarPath = contact.profileImage,
        )
        Spacer(Modifier.size(10.dp))
        Text(
            contact.displayName.ifBlank { contact.name.ifBlank { contact.address } },
            fontSize = 15.5.sp,
            fontWeight = FontWeight.SemiBold,
            color = Velta.tokens.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** Calls view (web renderCallsView): the LOCAL ended-call log. */
@Composable
private fun CallsView(model: AppModel) {
    Column(Modifier.fillMaxSize()) {
        SideViewShell(L.t("Calls"), L.t("Calls you ended on this device (kept locally — the core stores no call log)")) {
            if (model.callLog.isEmpty()) {
                SideViewEmpty(L.t("No calls yet"))
            } else {
                LazyColumn(Modifier.weight(1f)) {
                    items(model.callLog, key = { "${it.chatId}-${it.ts}" }) { entry ->
                        val chat = model.chats.firstOrNull { it.id == entry.chatId }
                        val interaction = remember { MutableInteractionSource() }
                        Row(
                            Modifier
                                .rowSurface(interaction)
                                .fillMaxWidth()
                                .clickable(
                                    interactionSource = interaction,
                                    indication = null,
                                ) {
                                    model.toggleListView("chats")
                                    model.openChatById(entry.chatId)
                                }
                                .padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                Modifier.size(42.dp).background(Velta.tokens.bgHover, RoundedCornerShape(percent = 50)),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(VeltaIcons.phone, contentDescription = null, modifier = Modifier.size(20.dp), tint = Velta.tokens.textDim)
                            }
                            Spacer(Modifier.size(10.dp))
                            Text(
                                chat?.name ?: L.t("Unknown chat"),
                                fontSize = 15.5.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = Velta.tokens.text,
                                modifier = Modifier.weight(1f),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(timeAgo(entry.ts), fontSize = 12.sp, color = Velta.tokens.textDim)
                        }
                    }
                }
            }
        }
    }
}

/** "Your QR code" (web renderQrView): the self invite as a locally encoded
 * matrix (the core SVG card is a web presentation) + link + copy/share. */
@Composable
private fun QrView(model: AppModel) {
    LaunchedEffect(Unit) { model.loadInviteQr() }
    var tab by remember { mutableStateOf("mine") }
    val scanAvailable = model.requestQrScan != null
    Column(Modifier.fillMaxSize().padding(horizontal = 8.dp)) {
        SideViewShell(
            L.t("Your QR code"),
            L.t(
                if (tab == "scan") "Point the camera at someone's QR code to start a chat or join a group"
                else "Others scan this to reach you with verified encryption",
            ),
        ) {
            Column(Modifier.fillMaxSize()) {
                if (scanAvailable) {
                    Row(
                        Modifier.fillMaxWidth().padding(bottom = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        listOf("mine" to "My code", "scan" to "Scan a QR code").forEach { (key, label) ->
                            val active = tab == key
                            Box(
                                Modifier
                                    .weight(1f)
                                    .clip(RoundedCornerShape(percent = 50))
                                    .background(if (active) Velta.tokens.accent else Velta.tokens.bgHover)
                                    .clickable { tab = key }
                                    .padding(horizontal = 10.dp, vertical = 5.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    L.t(label),
                                    fontSize = 11.5.sp,
                                    color = if (active) Velta.tokens.onAccentChip else Velta.tokens.textDim,
                                )
                            }
                        }
                    }
                }
                if (tab == "scan" && scanAvailable) {
                    Text(
                        L.t("Point the camera at someone's QR code to start a chat or join a group"),
                        fontSize = 13.5.sp,
                        color = Velta.tokens.textDim,
                        modifier = Modifier.padding(vertical = 18.dp),
                    )
                    Button(onClick = { model.requestQrScan?.invoke() }) {
                        Icon(VeltaIcons.camera, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.size(6.dp))
                        Text(L.t("Scan a QR code"))
                    }
                } else {
                    when {
                        model.inviteLoading -> SideViewEmpty(L.t("Generating QR code…"))
                        model.inviteError != null -> SideViewEmpty("${L.t("Couldn't create the invite:")} ${model.inviteError}")
                        model.inviteLink != null -> {
                            Spacer(Modifier.size(6.dp)) // web .qr-view gap 12
                            // Domain tabs (web mountInviteDomains): builtin
                            // hosts, velta.cc first/default. Every tab,
                            // including i.delta.chat, draws the same branded
                            // square. The web still mounts the core card on
                            // that tab; the link text stays the core URL.
                            Row(
                                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                model.inviteDomains().forEach { domain ->
                                    val active = model.inviteDomain == domain
                                    Box(
                                        Modifier
                                            .clip(RoundedCornerShape(percent = 50))
                                            .background(if (active) Velta.tokens.accent else Velta.tokens.bgHover)
                                            .clickable { model.onSetInviteDomain(domain) }
                                            .padding(horizontal = 10.dp, vertical = 5.dp),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Text(
                                            domain,
                                            fontSize = 11.5.sp,
                                            color = if (active) Velta.tokens.onAccentChip else Velta.tokens.textDim,
                                            maxLines = 1,
                                        )
                                    }
                                }
                            }
                            Spacer(Modifier.size(8.dp))
                            val link = rewriteInviteHost(model.inviteLink!!, model.inviteDomain)
                                ?: model.inviteLink!!
                            BrandedQrSquare(link)
                            Text(
                                link,
                                fontSize = 12.5.sp,
                                color = Velta.tokens.accent,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(Velta.tokens.bgHover, RoundedCornerShape(8.dp))
                                    .padding(10.dp),
                            )
                            Row(
                                Modifier.fillMaxWidth().padding(top = 8.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                            ) {
                                val clipboard = LocalClipboardManager.current
                                TextButton(onClick = { clipboard.setText(AnnotatedString(link)) }) {
                                    Icon(VeltaIcons.copy, contentDescription = null, modifier = Modifier.size(18.dp))
                                    Spacer(Modifier.size(6.dp))
                                    Text(L.t("Copy a link"))
                                }
                                if (model.shareText != null) {
                                    TextButton(onClick = { model.shareText?.invoke(link) }) {
                                        Icon(VeltaIcons.share, contentDescription = null, modifier = Modifier.size(18.dp))
                                        Spacer(Modifier.size(6.dp))
                                        Text(L.t("Share a link"))
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

/** Search screen (web renderSearchView): live name filter + the Archived tab. */
@Composable
private fun SearchView(model: AppModel, tab: String, onTab: (String) -> Unit) {
    LaunchedEffect(tab) { if (tab == "archived") model.loadArchivedChats() }
    var query by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize()) {
        SideViewShell("", "") {
            Column(Modifier.fillMaxSize()) {
                Row(
                    Modifier.fillMaxWidth().padding(bottom = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    val archivedLabel = L.t("Archived") +
                        (model.archivedChats.takeIf { it.isNotEmpty() }?.let { " (${it.size})" } ?: "")
                    listOf("search" to L.t("Search"), "archived" to archivedLabel).forEach { (key, label) ->
                        val active = tab == key
                        Box(
                            Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(percent = 50))
                                .background(if (active) Velta.tokens.accent else Velta.tokens.bgHover)
                                .clickable { onTab(key) }
                                .padding(horizontal = 10.dp, vertical = 5.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(label, fontSize = 11.5.sp, color = if (active) Velta.tokens.onAccentChip else Velta.tokens.textDim)
                        }
                    }
                }
                if (tab == "archived") {
                    if (model.archivedChats.isEmpty()) {
                        SideViewEmpty(L.t("No archived chats"))
                    } else {
                        LazyColumn(Modifier.weight(1f)) {
                            items(model.archivedChats, key = { it.id }) { item ->
                                ContactLikeChatRow(item, subSize = 12.sp) { model.openChatById(item.id) }
                            }
                        }
                    }
                } else {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        singleLine = true,
                        placeholder = { Text(L.t("Search chats…")) },
                        modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp),
                    )
                    val q = query.trim().lowercase()
                    when {
                        q.length < 2 -> SideViewEmpty(L.t("Type to search chats."))
                        else -> {
                            val hits = model.chats.filter { it.name.lowercase().contains(q) }.take(30)
                            if (hits.isEmpty()) {
                                SideViewEmpty(L.t("No chats found."))
                            } else {
                                LazyColumn(Modifier.weight(1f)) {
                                    items(hits, key = { it.id }) { item ->
                                        // Web search hits are full chat-items
                                        // (.ci-name 15.5 / .ci-last 14).
                                        ContactLikeChatRow(item, subSize = 14.sp) { model.openChat(item) }
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

/** Side-view chat row. [subSize] follows the web's per-role sizes: search
 *  hits are full chat-items (.ci-last 14px), archived rows use .archived-sub
 *  (12px) — one anatomy, two deliberate sub sizes. */
@Composable
internal fun ContactLikeChatRow(item: ChatListItem, subSize: TextUnit, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Row(
        Modifier
            .rowSurface(interaction)
            .fillMaxWidth()
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarTile(
            name = item.name,
            colorHex = item.color,
            kind = chatKindOf(item),
            size = 42.dp,
            identityFpr = null,
            avatarPath = item.avatarPath,
        )
        Spacer(Modifier.size(10.dp))
        Column(Modifier.weight(1f)) {
            Text(item.name, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold, color = Velta.tokens.text, maxLines = 1)
            val preview = listPreview(item)
            if (preview.isNotBlank()) {
                Text(preview, fontSize = subSize, color = Velta.tokens.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun SideOptionRow(label: String, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Row(
        Modifier
            .rowSurface(interaction)
            .fillMaxWidth()
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, fontSize = 14.5.sp, fontWeight = FontWeight.Medium, color = Velta.tokens.text, modifier = Modifier.weight(1f))
        Icon(VeltaIcons.chevronRight, contentDescription = null, modifier = Modifier.size(20.dp), tint = Velta.tokens.textDim)
    }
}

/** "Start something" (web renderNewChatView + newChatOptions, in order). */
@Composable
private fun NewChatView(model: AppModel) {
    Column(Modifier.fillMaxSize()) {
        SideViewShell(L.t("Start something"), L.t("Pick what to create")) {
            LazyColumn(Modifier.weight(1f)) {
                item {
                    SideOptionRow(L.t("New chat")) {
                        model.toggleListView("chats")
                        model.startNewChatFlow()
                    }
                }
                item {
                    SideOptionRow(L.t("New group")) {
                        model.toggleListView("chats")
                        model.startNewGroupFlow()
                    }
                }
                item {
                    SideOptionRow(L.t("New channel")) {
                        model.toggleListView("chats")
                        model.startNewChannelFlow()
                    }
                }
                // Web's "New local group (no relay)" is P2P-gated; KMP has no
                // P2P flag, so the option never shows (web: p2pEnabled()).
                item {
                    SideOptionRow(L.t("Join chat via invite link")) {
                        model.toggleListView("chats")
                        model.openJoinFromNewChat()
                    }
                }
                item {
                    SideOptionRow(L.t("Add a relay to this account")) {
                        model.toggleListView("chats")
                        model.openJoinFromNewChat()
                    }
                }
                item {
                    SideOptionRow(L.t("Add account via invite link")) {
                        model.toggleListView("chats")
                        model.addAccountFromSwitcher()
                    }
                }
            }
        }
    }
}

/** Contact picker screen (web pickContactModal): single tap = pick; multi
 * toggles a selection confirmed with Add. */
@Composable
private fun PickContactsScreen(model: AppModel) {
    val request = model.contactPick ?: return
    val selected = remember { mutableStateOf(setOf<Long>()) }
    LaunchedEffect(Unit) { model.refreshContacts() }
    PlatformBackHandler { model.cancelContactPick() }
    Column(
        Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.statusBars)
            .padding(horizontal = 8.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = { model.cancelContactPick() }) {
                Icon(VeltaIcons.chevronLeft, contentDescription = L.t("Back"), modifier = Modifier.size(26.dp), tint = Velta.tokens.textDim)
            }
            Text(L.t(request.titleKey), fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (request.multi) {
                // Web footButtons ok = .btn-primary — the ONE filled accent action.
                Button(
                    onClick = { model.onContactsPicked(model.contacts.filter { it.id in selected.value }) },
                    enabled = selected.value.isNotEmpty(),
                ) { Text(L.t("Add")) }
            }
        }
        KnownToggleRow(model)
        val known = model.knownContactIds()
        val shown = model.visiblePickContacts(
            if (model.knownContactsOnly) model.contacts.filter { it.id in known } else model.contacts,
        )
        if (shown.isEmpty()) {
            SideViewEmpty(L.t("Nobody here yet — untick “Show only known contacts” to see everyone."))
        } else {
            LazyColumn(Modifier.weight(1f)) {
                items(shown, key = { it.id }) { contact ->
                    val picked = contact.id in selected.value
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .background(if (picked) Velta.tokens.selectionBg else androidx.compose.ui.graphics.Color.Transparent, RoundedCornerShape(10.dp))
                            .clickable {
                                if (request.multi) {
                                    selected.value = if (picked) selected.value - contact.id else selected.value + contact.id
                                } else {
                                    model.onContactsPicked(listOf(contact))
                                }
                            }
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AvatarTile(
                            name = contact.displayName.ifBlank { contact.name.ifBlank { contact.address } },
                            colorHex = contact.color,
                            kind = null,
                            size = 42.dp,
                            avatarPath = contact.profileImage,
                        )
                        Spacer(Modifier.size(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                contact.displayName.ifBlank { contact.name.ifBlank { contact.address } },
                                fontSize = 15.5.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = Velta.tokens.text,
                                maxLines = 1,
                            )
                            if (contact.address.isNotBlank()) {
                                Text(contact.address, fontSize = 12.5.sp, color = Velta.tokens.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        if (picked) {
                            Icon(VeltaIcons.tick1, contentDescription = null, modifier = Modifier.size(18.dp), tint = Velta.tokens.accent)
                        }
                    }
                }
            }
        }
    }
}

/**
 * Web .modal contract (main.css:2110-2143, 2294-2305): centered radius-16
 * bgSidebar card with a 1px border over a 45% scrim, width capped 420px —
 * and on a phone-width window (the web's ≤600px breakpoint) a FULL-SCREEN
 * page instead. Foot = ONE filled accent confirm + a text cancel; scrim and
 * back dismiss. `.text-field` placeholders are hints — pass `placeholder`,
 * never floating labels.
 */
@Composable
private fun VeltaDialog(
    title: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    confirmEnabled: Boolean = true,
    dismissLabel: String? = null,
    body: @Composable () -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val fullScreen = maxWidth < 600.dp
        Box(
            Modifier
                .fillMaxSize()
                .background(Color(0x73101010)) // rgba(16,16,16,.45)
                .clickable(
                    interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
                    indication = null,
                ) { onDismiss() },
        )
        PlatformBackHandler { onDismiss() }
        if (fullScreen) {
            Column(
                Modifier
                    .fillMaxSize()
                    .background(Velta.tokens.bg)
                    .windowInsetsPadding(WindowInsets.statusBars),
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onDismiss) {
                        Icon(VeltaIcons.close, contentDescription = L.t("Close"), modifier = Modifier.size(22.dp), tint = Velta.tokens.text)
                    }
                    Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                }
                Column(Modifier.weight(1f).padding(16.dp)) { body() }
                Row(
                    Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                ) {
                    TextButton(onClick = onDismiss) { Text(dismissLabel ?: L.t("Cancel")) }
                    Button(onClick = onConfirm, enabled = confirmEnabled) { Text(confirmLabel) }
                }
            }
        } else {
            Column(
                Modifier
                    .align(Alignment.Center)
                    .widthIn(max = 420.dp)
                    .background(Velta.tokens.bgSidebar, RoundedCornerShape(16.dp))
                    .border(1.dp, Velta.tokens.border, RoundedCornerShape(16.dp))
                    .padding(16.dp),
            ) {
                Text(title, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.size(12.dp))
                body()
                Spacer(Modifier.size(16.dp))
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                ) {
                    TextButton(onClick = onDismiss) { Text(dismissLabel ?: L.t("Cancel")) }
                    Button(onClick = onConfirm, enabled = confirmEnabled) { Text(confirmLabel) }
                }
            }
        }
    }
}

/** stable askBatteryExemption / batteryPromptModal: asked once; Allow opens
 *  the system exemption dialog, any answer or close is remembered. */
@Composable
private fun BatteryPromptDialog(model: AppModel) {
    val maker = makerLabel(model.deviceMaker)
    VeltaDialog(
        title = L.t("Keep messages arriving"),
        confirmLabel = L.t("Allow"),
        onConfirm = { model.answerBatteryPrompt(true) },
        onDismiss = { model.answerBatteryPrompt(false) },
        dismissLabel = L.t("Not now"),
    ) {
        Text(
            L.t("Android stops Velta from syncing after you leave the app, so new messages wait until you open it. Allow unrestricted battery use so mail keeps arriving in the background."),
            color = Velta.tokens.text,
        )
        TextButton(onClick = { model.openHttp?.invoke(dontKillMyAppUrl(model.deviceMaker)) }) {
            Text(if (maker.isNotEmpty()) L.t("Extra steps for {maker} phones").replace("{maker}", maker) else L.t("Extra steps for your phone"))
        }
    }
}

/** Group name dialog (web askGroupName + #177 admin-group switch). */
@Composable
private fun GroupNameDialog(model: AppModel) {
    if (!model.showGroupNameDialog) return
    var name by remember { mutableStateOf(L.t("New group")) }
    var admin by remember { mutableStateOf(false) }
    VeltaDialog(
        title = L.t("New group"),
        confirmLabel = L.t("Create group"),
        onConfirm = { model.createGroup(name.trim().ifBlank { L.t("New group") }, admin) },
        onDismiss = { model.showGroupNameDialog = false },
    ) {
        Column {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                singleLine = true,
                placeholder = { Text(L.t("Group name")) },
            )
            Row(
                Modifier.clickable { admin = !admin }.padding(top = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked = admin, onCheckedChange = { admin = it })
                Column {
                    Text(L.t("Admin group"))
                    Text(
                        L.t("Only you can add or remove members and edit the group. Protection works only in Velta and ArcaneChat."),
                        fontSize = 11.5.sp,
                        color = Velta.tokens.textDim,
                    )
                }
            }
        }
    }
}

/** Channel name dialog (web askText → createChat channel → create_broadcast). */
@Composable
private fun ChannelDialog(model: AppModel) {
    if (!model.showChannelDialog) return
    var name by remember { mutableStateOf("") }
    VeltaDialog(
        title = L.t("New channel"),
        confirmLabel = L.t("Create channel"),
        onConfirm = { model.createChannel(name.trim().ifBlank { L.t("New channel") }) },
        onDismiss = { model.showChannelDialog = false },
    ) {
        OutlinedTextField(
            value = name,
            onValueChange = { name = it },
            singleLine = true,
            placeholder = { Text(L.t("New channel")) },
        )
    }
}

/** The relay zone (web .relay-zone, main.css:289): 10dp padding above and
 *  below the 6dp meter. One equal segment per relay with its OWN state color
 *  (web renderRelayLine + parseConnectivityHtml + #76 probe downgrade);
 *  empty parse → a single combined segment from the account connectivity.
 *  The sending relay's segment runs the data-sending dashes. The 6dp meter
 *  itself is the ONLY tappable part (opens the Relays screen; a KMP
 *  affordance — the web line is role="status"): the padding bands are not
 *  in the touch target, they used to overlap the category chips below and
 *  steal their taps.
 *  [detailShown] overlays the web's .relay-detail chips (mobile pull-open,
 *  app.js:1446) — one chip per segment (see [RelayDetailRow]). */
@Composable
private fun RelayZone(model: AppModel, detailShown: Boolean) {
    val accountColor = relayColorFor(relayBarState(model.relayConnectivity))
    val relayStatusLabel = L.t("Relay status")
    val segments = model.relaySegments
    Box(Modifier.fillMaxWidth().height(26.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(6.dp)
                .align(Alignment.Center)
                .clickable { model.openRelays() }
                .semantics { contentDescription = relayStatusLabel },
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (segments.isEmpty()) {
                Box(Modifier.weight(1f).fillMaxHeight().background(accountColor))
            } else {
                val shift = rememberInfiniteTransition(label = "relay-dashes").animateFloat(
                    initialValue = 0f,
                    targetValue = 12f,
                    animationSpec = infiniteRepeatable(
                        tween(450, easing = LinearEasing),
                    ),
                    label = "relay-dash-offset",
                )
                segments.forEach { seg ->
                    val color = relayColorFor(seg.state)
                    Box(
                        Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .drawBehind {
                                if (seg.isSendRelay && model.sending) {
                                    // data-sending: dashes of currentColor marching rightward.
                                    val w = size.width / 12f
                                    var x = -(shift.value / 12f) * (w * 2)
                                    while (x < size.width) {
                                        drawRect(color, topLeft = Offset(x, 0f), size = androidx.compose.ui.geometry.Size(w, size.height))
                                        x += w * 2
                                    }
                                } else {
                                    drawRect(color)
                                }
                            }
                            .semantics { contentDescription = seg.title },
                    )
                }
            }
        }
        if (detailShown) {
            RelayDetailRow(model, Modifier.matchParentSize())
        }
    }
}

/** Web .relay-seg state colors (main.css:239-249). */
private fun relayColorFor(state: String): Color = when (state) {
    "ok" -> RELAY_OK
    "down" -> RELAY_DOWN
    "offline" -> Color(0xFF9AA0A6)
    "local" -> Color(0xFF4C8DFF)
    else -> RELAY_WAIT // connecting / unreachable / delayed
}

/** Web .relay-detail-chip (main.css:305): one pill per strip segment —
 *  masked domain + the segment title, the sending relay marked with an
 *  envelope colored by its own segment state. The web appends the quota
 *  percent when its parse has one; the KMP's segment titles already carry
 *  the state text, so the title rides as the suffix (web's no-quota
 *  fallback path, app.js:1401). */
@Composable
private fun RelayDetailRow(model: AppModel, modifier: Modifier) {
    val segments = model.relaySegments
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (segments.isEmpty()) {
            RelayDetailChip(null, "", relayBarState(model.relayConnectivity), false, Modifier.weight(1f))
        } else {
            segments.forEach { seg ->
                RelayDetailChip(seg.domain, seg.title, seg.state, seg.isSendRelay, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun RelayDetailChip(
    domain: String?,
    title: String,
    state: String,
    isSend: Boolean,
    modifier: Modifier,
) {
    Box(
        modifier
            .fillMaxHeight()
            .clip(RoundedCornerShape(999.dp))
            .background(Velta.tokens.bgSidebar)
            .border(
                1.dp,
                when (state) {
                    "down" -> RELAY_DOWN
                    "unreachable", "offline" -> RELAY_WAIT
                    else -> Velta.tokens.border
                },
                RoundedCornerShape(999.dp),
            )
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (isSend) {
                // The sending relay: static envelope (web .relay-detail-send),
                // colored by the segment's own state.
                Icon(
                    VeltaIcons.relaySend,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = relayColorFor(state),
                )
            }
            Text(
                maskRelayDomain(domain) + if (title.isNotBlank()) " · $title" else "",
                fontSize = 11.sp,
                lineHeight = 11.sp,
                color = Velta.tokens.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Web maskRelayDomain (app.js:1266): "rel*.dev" — first 3 chars, a star,
 *  then ONLY the last dot label; "cha*.uk" for two-label hosts. */
internal fun maskRelayDomain(domain: String?): String {
    val d = domain ?: ""
    val i = d.lastIndexOf('.')
    if (i <= 0) return if (d.isNotEmpty()) d.take(3) + "*" else "relay"
    return d.take(3) + "*." + d.substring(i + 1)
}

/** Web renderRelayLine's account-wide color. 4000 connected, 2000–3999 connecting, below that down. */
internal fun relayBarState(connectivity: Int?): String = when {
    connectivity == null -> "connecting"
    connectivity >= 4000 -> "ok"
    connectivity >= 2000 -> "connecting"
    else -> "down"
}

/**
 * The web sidebar's bottom action bar (.list-bar, index.html:60-79, #329):
 * solid bgSidebar + 1dp top border, stretch-aligned 46dp buttons (icons at
 * --ico-4 = 22dp), gap 6, padding 8/10/10. Chats/Contacts/Calls/QR toggle
 * their side views (web setListView: the active button gets accent ink +
 * 2dp inset bottom accent line, top corners squared); "+" is the accent
 * square (.bar-accent, #109: never a tab); Menu rides the DropdownMenu.
 */
@Composable
private fun ListBar(model: AppModel) {
    var menuOpen by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().background(Velta.tokens.bgSidebar)) {
        HorizontalDivider(color = Velta.tokens.border)
        Row(
            Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, top = 8.dp, bottom = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            BarViewButton(VeltaIcons.chats, L.t("Chats"), "chats", model)
            BarViewButton(VeltaIcons.contacts, L.t("Contacts"), "contacts", model)
            BarViewButton(VeltaIcons.phone, L.t("Calls"), "calls", model)
            BarViewButton(VeltaIcons.qr, L.t("QR code"), "qr", model)
            Box(
                Modifier
                    .weight(1f)
                    .height(46.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Velta.tokens.accent)
                    .clickable { model.toggleListView(if (model.listView == "new") "chats" else "new") },
                contentAlignment = Alignment.Center,
            ) {
                Icon(VeltaIcons.plus, contentDescription = L.t("New chat"), modifier = Modifier.size(22.dp), tint = Velta.tokens.onAccent)
            }
            Box(Modifier.weight(1f)) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(46.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { menuOpen = true },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(VeltaIcons.menu, contentDescription = L.t("Menu"), modifier = Modifier.size(22.dp), tint = Velta.tokens.text)
                }
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
                        text = { Text(L.t("Invite link")) },
                        onClick = {
                            menuOpen = false
                            model.joinChecked = null
                            model.joinError = null
                            model.screen = AppModel.Screen.Join
                        },
                    )
                    // No "Refresh" item: the web menu has none — chat-list
                    // reloads are event-driven (MsgsChanged → dirty-coalesced
                    // loadChats), a manual yank is dead weight.
                }
            }
        }
    }
}

/** One .bar-btn: the active view gets accent ink + the inset bottom accent line. */
@Composable
private fun RowScope.BarViewButton(icon: ImageVector, label: String, view: String, model: AppModel) {
    val active = model.listView == view
    val accent = Velta.tokens.accent
    val interaction = remember { MutableInteractionSource() }
    Box(
        Modifier
            .weight(1f)
            .height(46.dp)
            .clip(
                if (active) {
                    RoundedCornerShape(topStart = 8.dp, topEnd = 8.dp, bottomStart = 0.dp, bottomEnd = 0.dp)
                } else {
                    RoundedCornerShape(8.dp)
                },
            )
            .rowSurface(interaction)
            .clickable(interactionSource = interaction, indication = null) { model.toggleListView(view) }
            .drawBehind {
                if (active) {
                    drawLine(
                        accent,
                        Offset(0f, size.height - 1.dp.toPx()),
                        Offset(size.width, size.height - 1.dp.toPx()),
                        strokeWidth = 2.dp.toPx(),
                    )
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, modifier = Modifier.size(22.dp), tint = if (active) Velta.tokens.accent else Velta.tokens.text)
    }
}

/**
 * Web rewriteInviteHost (invite-domains.js:20-27): slices the canonical
 * `https://i.delta.chat/#` prefix off the core link — the payload stays
 * byte-identical — and re-hosts it. velta.cc gets the `/join/?` universal
 * form; the other mirrors keep the `/#` hash form.
 */
private const val CORE_INVITE_PREFIX = "https://i.delta.chat/#"

internal fun rewriteInviteHost(link: String, domain: String): String? {
    if (!link.startsWith(CORE_INVITE_PREFIX)) return null
    val payload = link.removePrefix(CORE_INVITE_PREFIX)
    return when (domain) {
        "i.delta.chat" -> link
        "velta.cc" -> "https://velta.cc/join/?$payload"
        else -> "https://$domain/#$payload"
    }
}

/**
 * The Tauri "My code" look (web brandedQrSvg, invite-domains.js:49-53):
 * a plain white 512×512 square — quiet zone 48px, the optimally-encoded
 * matrix scaled 416/size, and the VELTA_QR_LOGO badge dead-center
 * (white ring r56, #1c1c1c disc r48, the V mark at 84×84/214,216).
 */
@Composable
internal fun BrandedQrSquare(link: String) {
    val qr = remember(link) { runCatching { QrEncode.encode(link) }.getOrNull() }
    val density = LocalDensity.current
    var boxPx by remember { mutableIntStateOf(0) }
    val logoDp = with(density) { (boxPx * 84f / 512f).toDp() }
    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .onSizeChanged { boxPx = it.width },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val s = size.width / 512f
            drawRect(Color.White)
            if (qr != null) {
                val cell = 416f * s / qr.size
                for (y in 0 until qr.size) for (x in 0 until qr.size) {
                    if (qr[x, y]) {
                        drawRect(
                            Color.Black,
                            topLeft = Offset(48f * s + x * cell, 48f * s + y * cell),
                            size = androidx.compose.ui.geometry.Size(cell, cell),
                        )
                    }
                }
            }
            // VELTA_QR_LOGO: white ring r56 + #1c1c1c disc r48 at (256,256).
            drawCircle(Color.White, radius = 56f * s, center = Offset(256f * s, 256f * s))
            drawCircle(Color(0xFF1C1C1C), radius = 48f * s, center = Offset(256f * s, 256f * s))
        }
        Image(
            painterResource(Res.drawable.v_logo),
            contentDescription = null,
            modifier = Modifier.size(logoDp),
            contentScale = ContentScale.Fit,
        )
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

/**
 * Web states contract (main.css:163-165, 1792-1795): hover and focus change
 * SURFACES, never text — hover = bgHover fill (pointer only), keyboard
 * focus = a 2px --focus-ring outline, selection = selection-bg. Pass the
 * SAME interaction source to `.clickable` so hover/focus register; pass
 * `hover = false` for surfaces whose web hover changes ink instead (chips).
 */
@Composable
private fun Modifier.rowSurface(
    interaction: androidx.compose.foundation.interaction.MutableInteractionSource,
    hover: Boolean = true,
    selected: Boolean = false,
): Modifier {
    val hovered by interaction.collectIsHoveredAsState()
    val focused by interaction.collectIsFocusedAsState()
    val ring = Velta.tokens.focusRing
    val hoverBg = Velta.tokens.bgHover
    val selBg = Velta.tokens.selectionBg
    return this
        .focusable(interactionSource = interaction)
        .hoverable(interaction)
        .drawBehind {
            when {
                focused -> drawRect(ring, style = Stroke(width = 2.dp.toPx()))
                hover && hovered -> drawRect(hoverBg)
                selected -> drawRect(selBg)
            }
        }
}

/** Web <velta-avatar> (components.js): 22%-radius rounded square; special
 * kinds (saved/device) wear the 135° gradient tile + a 55% white icon;
 * 1:1 peers with a key wear the fingerprint identity matrix (web avatar.js);
 * photos decode over the tile; everything else a color/Prism initials tile. */
@Composable
private fun AvatarTile(
    name: String,
    colorHex: String?,
    kind: String?,
    size: androidx.compose.ui.unit.Dp,
    identityFpr: String? = null,
    avatarPath: String? = null,
) {
    val special = kind == "saved" || kind == "device"
    val cells = if (!special && kind == "single") identityFpr?.let { identityCells(it) } else null
    val photo = avatarPath?.takeIf { it.isNotBlank() }
    val photoBitmap = photo?.let { path -> remember(path) { decodeImage(path) } }
    val tileColor = colorHex?.takeIf { it.startsWith("#") }?.let { runCatching { Accent.toColor(it) }.getOrNull() }
        ?: prismTileColor(name)
    Box(
        modifier = Modifier
            .size(size)
            .clip(RoundedCornerShape(size * 0.22f))
            .background(
                when {
                    special -> androidx.compose.ui.graphics.Color.Transparent
                    else -> tileColor
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (special) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(
                        Brush.linearGradient(listOf(Color(0xFF5AA2E6), Color(0xFF8774E1))),
                    ),
            )
            Icon(
                if (kind == "saved") VeltaIcons.avatarStar else VeltaIcons.device,
                contentDescription = null,
                modifier = Modifier.size(size * 0.55f),
                tint = androidx.compose.ui.graphics.Color.White,
            )
        } else {
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
            }
            when {
                // Web <velta-avatar kind="single">: the photo is inset on the
                // matrix, or on the contact color until the fingerprint arrives.
                photoBitmap != null && kind == "single" -> Box(
                    Modifier
                        .fillMaxSize()
                        .padding(size * 0.1917f)
                        .background(Color(0xFF1C1C1C), RoundedCornerShape(size * 0.243f))
                        .padding(size * 0.025f)
                        .clip(RoundedCornerShape(size * 0.22f)),
                ) {
                    Image(
                        photoBitmap,
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize(),
                        contentScale = ContentScale.Crop,
                    )
                }
                photoBitmap != null -> Image(
                    photoBitmap,
                    contentDescription = null,
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Crop,
                )
                cells == null -> Text(
                    prismInitials(name),
                    fontWeight = FontWeight.SemiBold,
                    fontSize = (size.value * 0.38f).sp,
                    color = Color(0xFFF4F4F4),
                )
            }
        }
    }
}

@Composable
private fun ChatListRow(
    item: ChatListItem,
    identityFpr: String?,
    onMenu: ((Float, Float) -> Unit)? = null,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    // #334 step 5 (app.js createChatItem "contextmenu"): a long-press (the
    // platform long-press timeout, as the WebView's) or a right-click opens
    // the chat menu at the pointer. Tap still opens the chat.
    val haptics = LocalHapticFeedback.current
    var rowOrigin by remember { mutableStateOf(Offset.Zero) }
    val menuLabel = L.t("Chat menu")
    val latestMenu by rememberUpdatedState(onMenu)
    val latestClick by rememberUpdatedState(onClick)
    Row(
        modifier = Modifier
            .rowSurface(interaction)
            .fillMaxWidth()
            .onGloballyPositioned { rowOrigin = it.positionInWindow() }
            .then(
                if (onMenu == null) {
                    Modifier.clickable(interactionSource = interaction, indication = null, onClick = onClick)
                } else {
                    Modifier
                        .pointerInput(item.id) {
                            detectTapGestures(
                                onTap = { latestClick() },
                                onLongPress = { at ->
                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    latestMenu?.invoke(rowOrigin.x + at.x, rowOrigin.y + at.y)
                                },
                            )
                        }
                        .pointerInput(item.id) {
                            awaitPointerEventScope {
                                while (true) {
                                    val e = awaitPointerEvent()
                                    if (e.type == PointerEventType.Press && e.buttons.isSecondaryPressed) {
                                        val at = e.changes.first().position
                                        e.changes.forEach { it.consume() }
                                        latestMenu?.invoke(rowOrigin.x + at.x, rowOrigin.y + at.y)
                                    }
                                }
                            }
                        }
                        .semantics {
                            role = Role.Button
                            onClick { latestClick(); true }
                            onLongClick(label = menuLabel) {
                                latestMenu?.invoke(rowOrigin.x + 48f, rowOrigin.y + 24f); true
                            }
                        }
                }
            )
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarTile(
            name = item.name,
            colorHex = item.color,
            kind = chatKindOf(item),
            size = 48.dp,
            identityFpr = identityFpr,
            avatarPath = item.avatarPath,
        )
        Spacer(Modifier.size(10.dp))
        Column(Modifier.weight(1f)) {
            // ci-top: name + list stamp (web formatListTime).
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    item.name,
                    fontSize = 15.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = Velta.tokens.text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(Modifier.size(6.dp))
                // ChatListItem.lastUpdated is MILLISECONDS on the wire (web
                // _mapChatListItem: "core ChatListItem.lastUpdated is already
                // ms") — message timestamps are seconds, this field is not.
                Text(
                    item.lastUpdated?.let { formatListTime(it / 1000) } ?: "",
                    fontSize = 12.sp,
                    color = Velta.tokens.textDim,
                )
            }
            Spacer(Modifier.size(2.dp))
            // ci-bottom: ticks + preview + the right slot (unread > pin > mute).
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                val state = summaryStateOf(item.summaryStatus)
                if (state != "received") {
                    val glyph = when (state) {
                        "pending" -> VeltaIcons.clock
                        "failed" -> VeltaIcons.warn
                        "delivered" -> VeltaIcons.tick1
                        else -> VeltaIcons.tick2
                    }
                    Icon(
                        glyph,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = when (state) {
                            "failed" -> Velta.tokens.danger
                            "read" -> Velta.tokens.ticksRead
                            else -> Velta.tokens.textDim
                        },
                    )
                }
                RowPreview(item)
                when {
                    item.freshMessageCounter > 0 -> UnreadBadge(item.freshMessageCounter, item.isMuted)
                    item.isPinned -> Icon(VeltaIcons.pin, contentDescription = L.t("Pinned"), modifier = Modifier.size(16.dp), tint = Velta.tokens.textDim)
                    item.isMuted -> Icon(VeltaIcons.mute, contentDescription = L.t("Muted"), modifier = Modifier.size(16.dp), tint = Velta.tokens.textDim)
                }
            }
        }
    }
}

/** Web ci-last preview precedence (components.js render): Draft: red,
 * deaddrop "Contact request:" red, else the mapped summary. */
@Composable
private fun RowScope.RowPreview(item: ChatListItem) {
    val kind = chatKindOf(item)
    val preview = listPreview(item)
    val text = when {
        kind == "deaddrop" -> preview.ifBlank { L.t("tap to accept") }
        item.summaryText1 == "Draft:" -> item.summaryText2
        else -> preview
    }
    if (text.isBlank()) return
    val annotated = when {
        kind == "deaddrop" -> AnnotatedString.Builder().apply {
            pushStyle(SpanStyle(color = Velta.tokens.danger, fontWeight = FontWeight.SemiBold))
            append("${L.t("Contact request:")} ")
            pop()
            append(text)
        }.toAnnotatedString()
        item.summaryText1 == "Draft:" -> AnnotatedString.Builder().apply {
            pushStyle(SpanStyle(color = Velta.tokens.danger, fontWeight = FontWeight.SemiBold))
            // Web renders the core's untranslated "Draft:" prefix (components.js).
            append("Draft: ")
            pop()
            append(text)
        }.toAnnotatedString()
        else -> AnnotatedString(text)
    }
    Text(
        annotated,
        fontSize = 14.sp,
        color = Velta.tokens.textDim,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f),
    )
}

/** Web .ci-badge: accent-2 pill, 23dp min square, muted = grey variant. */
@Composable
private fun UnreadBadge(count: Int, muted: Boolean) {
    Box(
        Modifier
            .background(
                if (muted) Velta.tokens.textDim else Velta.tokens.accent2,
                RoundedCornerShape(12.dp),
            )
            .widthIn(min = 23.dp)
            .height(23.dp)
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            if (count > 999) "999+" else count.toString(),
            fontSize = 12.5.sp,
            fontWeight = FontWeight.SemiBold,
            // Web .ci-badge.muted ink — --on-badge-muted (light = #f4f4f4).
            color = if (muted) Velta.tokens.onBadgeMuted else Velta.tokens.onBadge,
        )
    }
}

/** Prism avatar fill (web parity): the person color, darkened for 3:1 initials. */
private fun prismTileColor(name: String): androidx.compose.ui.graphics.Color {
    val c = prismFill(name)
    return androidx.compose.ui.graphics.Color(c[0], c[1], c[2])
}

/** Sender-name ink: the contact color when we have one, else the name hash.
 *  Light bubbles darken (web --sender-light); dark and brutal lighten. */
private fun prismSenderColor(
    name: String,
    bg: androidx.compose.ui.graphics.Color,
    colorHex: String? = null,
    lighten: Boolean = true,
): androidx.compose.ui.graphics.Color {
    val bgRgb = intArrayOf(
        (bg.red * 255.0).roundToInt(),
        (bg.green * 255.0).roundToInt(),
        (bg.blue * 255.0).roundToInt(),
    )
    val parsed = colorHex?.let { runCatching { Accent.toColor(it) }.getOrNull() }
    val base = if (parsed != null) {
        intArrayOf(
            (parsed.red * 255.0).roundToInt(),
            (parsed.green * 255.0).roundToInt(),
            (parsed.blue * 255.0).roundToInt(),
        )
    } else {
        prismFill(name)
    }
    val c = prismReadableOn(base, bgRgb, 4.6, if (lighten) 1 else -1)
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

    /** Stable "Unread messages" line (`.unread-sep`). */
    data object UnreadSep : ChatRow {
        override val key: String get() = "unread-sep"
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
        // Stable toast()/errToast() lines (profile editor results).
        bottomBar = { ToastHost(model) },
    ) { inner ->
        Column(
            Modifier
                .padding(inner)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            // Stable drawer head: "Edit profile" (KMP has no drawer — Settings leads with it).
            TextButton(onClick = { model.openProfileEditor() }) { Text(L.t("Edit profile")) }
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
            SettingsSection(L.t("Notifications"))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .clickable { model.onSetMentionInMuted(!model.mentionInMuted) }
                    .padding(vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked = model.mentionInMuted, onCheckedChange = { model.onSetMentionInMuted(it) })
                Text(L.t("Notify me when mentioned in muted chats"))
            }
            // Stable drawer "Use background connection" (Android only).
            if (model.backgroundCapable) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { model.onSetBackgroundConnection(!model.backgroundConnection) }
                        .padding(vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(checked = model.backgroundConnection, onCheckedChange = { model.onSetBackgroundConnection(it) })
                    Text(L.t("Use background connection"))
                }
            }
            // Stable drawer "Push notifications" (push-settings.js, Android only).
            if (model.pushBridge != null) PushSettingsSection(model)
            // Stable drawer "Auto-download limit" + "Text-only mode" (#358).
            SettingsSection(L.t("Auto-download limit"))
            SettingsRadios(DOWNLOAD_LIMIT_OPTIONS, model.downloadLimit) { model.onSetDownloadLimit(it) }
            SettingsHint(L.t(DOWNLOAD_LIMIT_HINT))
            SettingsSection(L.t("Text-only mode"))
            SettingsRadios(TEXT_ONLY_OPTIONS, model.textOnlyMode) { model.onSetTextOnlyMode(it) }
            SettingsHint(L.t(TEXT_ONLY_HINT))
            SettingsSection(L.t("Invite link domains"))
            model.inviteDomains().forEach { host ->
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(host, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (host !in AppModel.INVITE_HOSTS) {
                        TextButton(onClick = { model.onRemoveInviteHost(host) }) {
                            Text(L.t("Remove"))
                        }
                    }
                }
            }
            var hostInput by remember { mutableStateOf("") }
            Row(
                Modifier.fillMaxWidth().padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = hostInput,
                    onValueChange = { hostInput = it },
                    placeholder = { Text("mirror.example.org") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = {
                    if (model.onAddInviteHost(hostInput)) hostInput = ""
                    else model.showToast(L.t("Enter a plain hostname, e.g. mirror.example.org"))
                }) { Text(L.t("Add")) }
            }
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
                L.t("Untranslated text stays in English."),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}

/** stable push-settings.js pushBodyHtml: state line (live), distributor
 *  radios + Off, or the ntfy link when none is installed, relay support,
 *  last push. Re-read on entry. */
@Composable
private fun PushSettingsSection(model: AppModel) {
    LaunchedEffect(Unit) { model.refreshPush() }
    val s = model.pushStatus ?: return
    SettingsSection(L.t("Push notifications"))
    Text(
        describePushState(s) { L.t(it) },
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.semantics { liveRegion = androidx.compose.ui.semantics.LiveRegionMode.Polite },
    )
    val options = pushOptions(s)
    if (options.isNotEmpty()) {
        Column(Modifier.selectableGroup().semantics { contentDescription = L.t("Push app") }) {
            SettingsRadios(options, pushSelectedValue(s)) { model.onPickPushApp(it) }
        }
    } else {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { model.openHttp?.invoke(PUSH_APP_URL) }) { Text(L.t("Get a push app (ntfy)")) }
        }
        SettingsHint(L.t("install one for instant delivery."))
    }
    SettingsHint(describeRelaySupport(model.relays.map { it.metadata?.supportsPush }) { L.t(it) })
    SettingsHint(describeLastPush(s.lastPush, wallClockSeconds() * 1000, ::formatDateHeader, ::formatTimestamp) { L.t(it) })
}

/** One radio per (value, English label) option; the whole row is the target. */
@Composable
private fun SettingsRadios(options: List<Pair<String, String>>, selected: String, onPick: (String) -> Unit) {
    options.forEach { (value, label) ->
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .selectable(selected = selected == value, role = androidx.compose.ui.semantics.Role.RadioButton) { onPick(value) }
                .padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = selected == value, onClick = null)
            Text(L.t(label), modifier = Modifier.padding(start = 12.dp))
        }
    }
}

@Composable
private fun SettingsHint(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = Velta.tokens.textDim,
        modifier = Modifier.padding(top = 4.dp),
    )
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
                        if (model.relaysLoading) L.t("Loading…") else L.t("No relays configured."),
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
                        // Stable puts these words in the letters' titles
                        // (relayFlagsHtml); touch has no hover, so list them.
                        Text(
                            RELAY_FLAG_LABELS.joinToString("\n") { (letter, key) -> "$letter — ${L.t(key)}" },
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
            meta?.admin?.trim()?.takeIf { it.isNotEmpty() }?.let { add(L.t("Admin: {admin}").replace("{admin}", it)) }
            val rcpt = meta?.maxSmtpRcptTo
            if (rcpt != null && rcpt > 0) add(L.t("Up to {rcpt} recipients per message").replace("{rcpt}", rcpt.toString()))
            if (meta?.canCompress == true) add(L.t("compressed connection"))
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
private fun ChatBackHost(model: AppModel, chat: AppModel.Screen.Chat) {
    // Swipe-back host (#334): the chat slides with the finger (or the
    // Android 14+ predictive back progress) while the chat list peeks
    // underneath with parallax, scale and dim; reduced motion keeps the
    // peek flat and skips the springs.
    val back = remember(chat.chatId) { SwipeOffset() }
    val scope = rememberCoroutineScope()
    val fancy = !rememberReducedMotion()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val widthPx = constraints.maxWidth.toFloat()
        // Remembered so per-frame offset changes never recompose ChatScreen.
        val commitBack: (Boolean?) -> Unit = remember(back, widthPx, fancy) {
            { fromLeft ->
                model.backSwipeActive = false
                back.slideOut(scope, backExitTarget(back.value, widthPx, fromLeft), fancy) {
                    model.backToChatList()
                }
            }
        }
        val onCommit = remember(commitBack) { { commitBack(null) } }
        val peeking by remember(back) { derivedStateOf { back.value != 0f } }
        PlatformPredictiveBackHandler(
            onProgress = { p, fromLeft -> back.snapTo(if (fancy) predictiveOffset(p, widthPx, fromLeft) else 0f) },
            onCancel = { back.settle(scope, 0f, fancy) },
            onBack = commitBack,
        )
        if (peeking) {
            Box(
                Modifier.fillMaxSize().graphicsLayer {
                    val peek = peekFor(back.value, widthPx, fancy)
                    translationX = peek.translationX
                    scaleX = peek.scale
                    scaleY = peek.scale
                },
            ) { ChatListScreen(model, peek = true) }
            // Dim + touch shield: the peeking list is a picture, not a target.
            Box(
                Modifier.fillMaxSize()
                    .drawBehind { drawRect(Color.Black.copy(alpha = peekFor(back.value, widthPx, fancy).dim)) }
                    .pointerInput(Unit) {
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false).consume()
                        }
                    },
            )
        }
        Box(
            Modifier.fillMaxSize().graphicsLayer {
                translationX = back.value
                // Lift the sliding pane off the list (a soft edge shadow).
                shadowElevation = if (back.value != 0f && fancy) 12.dp.toPx() else 0f
            },
        ) {
            ChatScreen(model, chat, back, widthPx, fancy, onCommit = onCommit)
        }
    }
}

@Composable
private fun ChatScreen(
    model: AppModel,
    chat: AppModel.Screen.Chat,
    back: SwipeOffset,
    paneWidthPx: Float,
    fancy: Boolean,
    onCommit: () -> Unit,
) {
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
        // A jump that loaded history first lets the prepend anchor settle,
        // so the two scrolls never cancel each other.
        if (model.pendingPrependCount > 0) {
            withTimeoutOrNull(1000) { snapshotFlow { model.pendingPrependCount }.first { it == 0 } }
        }
        val rows = chatRows(model.chatMessages, model.unreadLineId)
        val idx = rows.indexOfFirst { it is ChatRow.Message && it.message.id == wanted }
        if (idx >= 0) listState.animateScrollToItem(idx)
        model.pendingJumpToId = null
    }
    LaunchedEffect(model.chatMessages.size) {
        val rows = chatRows(model.chatMessages, model.unreadLineId)
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

    // System back (Android) returns to the chat list through ChatBackHost's
    // predictive handler; desktop uses ‹ Back.

    // Read receipts (#334, web per-visible-row markSeen): report the message
    // rows on screen; the model marks unseen incoming ones while the app is
    // in the foreground. Re-emits on scroll, reloads and foreground changes.
    // Stable _checkSeen: seen is a WATERMARK — the lowest row that counts as
    // seen (fully on screen, or a tall row filling the upper half) marks
    // every loaded message up to it. Nothing while the open position settles.
    LaunchedEffect(chat.chatId) {
        snapshotFlow {
            val rows = chatRows(model.chatMessages, model.unreadLineId)
            val info = listState.layoutInfo
            val watermark = if (model.openScroll != null) null else info.visibleItemsInfo
                .lastOrNull { item ->
                    rows.getOrNull(item.index) is ChatRow.Message &&
                        rowCountsAsSeen(item.offset, item.offset + item.size, info.viewportStartOffset + info.beforeContentPadding, info.viewportEndOffset - info.afterContentPadding)
                }
                ?.let { (rows[it.index] as ChatRow.Message).message.id }
            seenThrough(model.chatMessages.map { it.id }, watermark) to model.appInForeground
        }.collect { (ids, _) -> model.onMessagesVisible(ids) }
    }

    // Opening position (stable open): the "Unread messages" line at the top
    // of the history, or the newest message.
    LaunchedEffect(model.openScroll) {
        val target = model.openScroll ?: return@LaunchedEffect
        val rows = chatRows(model.chatMessages, model.unreadLineId)
        if (rows.isNotEmpty()) {
            val idx = when (target) {
                is OpenScroll.Unread -> rows.indexOf(ChatRow.UnreadSep).takeIf { it >= 0 }
                    ?: rows.indexOfFirst { it is ChatRow.Message && it.message.id == target.msgId }
                OpenScroll.Bottom -> rows.size - 1
            }
            listState.scrollToItem(idx.coerceIn(0, rows.size - 1))
        }
        model.openScroll = null
    }
    // Stable _nearBottom (< 220 px of history below the viewport).
    val nearBottomPx = with(LocalDensity.current) { NEAR_BOTTOM_PX.dp.roundToPx() }
    val atBottom by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()
            nearBottom(
                last?.index ?: -1,
                info.totalItemsCount,
                last?.let { it.offset + it.size - (info.viewportEndOffset - info.afterContentPadding) } ?: 0,
                nearBottomPx,
            )
        }
    }
    val goDownScope = rememberCoroutineScope()

    var headPx by remember { mutableIntStateOf(0) }
    var footPx by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current
    // Web back-swipe (chat-view.js:5460-5540): dragging the history leftward
    // slides the whole chat pane with the finger; past min(72dp, 28% width)
    // it commits to the chat list (ChatBackHost animates the exit), else it
    // springs home. Touches starting in the system gesture edges are left to
    // Android's own back gesture.
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val gestureInsets = WindowInsets.systemGestures
    val layoutDir = LocalLayoutDirection.current
    var listLeftPx by remember { mutableStateOf(0f) }
    val lens = model.replyTo == null && model.editingMsg == null && model.pendingAttachment == null
    GlassHost(
        Modifier.fillMaxSize().windowInsetsPadding(
            WindowInsets.ime.union(WindowInsets.navigationBars),
        ),
        content = {
        val rows = chatRows(model.chatMessages, model.unreadLineId)
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                // Web .main / .history-scroll are --bg-chat. The shell surface
                // is --bg-sidebar, and incoming bubbles share that color in
                // light (#f4f4f4) and nearly share it in dark (#181820 vs #1c1c26).
                .background(Velta.tokens.bgChat)
                .onGloballyPositioned { listLeftPx = it.positionInWindow().x - back.value }
                .pointerInput(Unit) {
                    if (!touchGesturesEnabled) return@pointerInput
                    val engage = SwipeSpec.ENGAGE_DP.dp.toPx()
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                        // Runs before the bubbles (Initial pass is parent → child):
                        // reset the per-touch flags they read.
                        model.gestureSkipDown = false
                        model.replySwipeActive = false
                        model.backSwipeActive = false
                        val windowX = listLeftPx + back.value + down.position.x
                        model.gestureEdgeDown = inSystemGestureZone(
                            windowX,
                            paneWidthPx,
                            gestureInsets.getLeft(this, layoutDir).toFloat(),
                            gestureInsets.getRight(this, layoutDir).toFloat(),
                        )
                        // Grab a pane that is still springing home.
                        val base = back.value
                        back.stop()
                        if (base != 0f && !model.gestureEdgeDown) model.backSwipeActive = true
                        var engaged = base != 0f && model.backSwipeActive
                        // Deltas, not absolute positions: the pane under the
                        // finger moves, so positions drift with it.
                        var dxc = 0f
                        var dyc = 0f
                        var past = false
                        val commit = backCommitPx(paneWidthPx, 1.dp.toPx())
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Initial)
                            val change = event.changes.firstOrNull()
                            if (event.changes.none { it.pressed } || change == null) {
                                if (engaged) {
                                    // A cancel (system took the touch) arrives pre-consumed.
                                    val cancelled = event.changes.all { it.isConsumed }
                                    if (releaseCommits(back.value, commit, cancelled)) onCommit()
                                    else back.settle(scope, 0f, fancy)
                                }
                                model.backSwipeActive = false
                                break
                            }
                            if (event.changes.size > 1 && !engaged) break
                            dxc += change.position.x - change.previousPosition.x
                            dyc += change.position.y - change.previousPosition.y
                            if (!engaged) {
                                // Stable gestureSkipTarget / _replySwipe / edge zones.
                                if (!backSwipeAllowed(model.replySwipeActive, model.gestureEdgeDown, model.gestureSkipDown)) break
                                when (swipeAxis(dxc, dyc, engage, positive = false)) {
                                    SwipeAxis.Vertical -> break
                                    SwipeAxis.Undecided -> continue
                                    SwipeAxis.Horizontal -> { engaged = true; model.backSwipeActive = true }
                                }
                            }
                            back.value = backFollow(base + dxc, paneWidthPx)
                            val t = thresholdTick(past, back.value, commit)
                            past = t.past
                            if (t.tick) haptics.performHapticFeedback(HapticFeedbackType.GestureThresholdActivate)
                            // Engaged: the history must not scroll under the swipe.
                            event.changes.forEach { it.consume() }
                        }
                    }
                },
            state = listState,
            contentPadding = PaddingValues(
                start = 12.dp,
                end = 12.dp,
                top = with(density) { headPx.toDp() } + 12.dp,
                bottom = with(density) { footPx.toDp() } + 12.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            items(rows, key = { it.key }) { row ->
                when (row) {
                    is ChatRow.Header -> DayHeader(row.text)
                    ChatRow.UnreadSep -> UnreadSeparator()
                    // Web .service-msg: system/info messages are mono pills,
                    // not bubbles.
                    is ChatRow.Message if row.message.isInfo -> ServiceMessage(row.message)
                    is ChatRow.Message -> {
                        val members = model.chatMembers[chat.chatId].orEmpty()
                        MessageBubble(
                            message = row.message,
                            sender = if (chat.isGroup && row.message.fromId != 1L) {
                                senderFace(
                                    row.message.sender,
                                    members.find { it.id == row.message.fromId },
                                    null,
                                    L.t("Unknown"),
                                    model.senderNames[row.message.fromId],
                                )
                            } else {
                                null
                            },
                            members = members,
                            model = model,
                        )
                    }
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
            // index.html #selection-bar overlays the head while selecting.
            if (model.selection.isNotEmpty()) SelectionBar(model) else
            Row(
                Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = { model.backToChatList() }) { Icon(VeltaIcons.chevronLeft, contentDescription = L.t("Back"), modifier = Modifier.size(26.dp), tint = Velta.tokens.textDim) }
                // Web velta-chat-head: avatar + name + status line; the whole
                // info zone opens the chat profile (web chat menu ≈ KMP Profile).
                val head = model.chatHead
                Row(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { model.openProfile(chat.chatId, chat.title) }
                        .padding(horizontal = 6.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AvatarTile(
                        name = chat.title,
                        colorHex = head?.colorHex,
                        kind = head?.kind ?: "single",
                        size = 42.dp,
                        identityFpr = head?.fingerprint,
                        avatarPath = head?.avatarPath,
                    )
                    Spacer(Modifier.size(10.dp))
                    Column {
                        Text(
                            chat.title,
                            fontSize = 16.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = Velta.tokens.text,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        chatHeadStatus(head)?.let { status ->
                            Text(
                                status,
                                fontSize = 13.sp,
                                color = Velta.tokens.textDim,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
                if (model.chatLoading) CircularProgressIndicator(Modifier.size(20.dp))
                // Stable #btn-chat-search, left of the chat menu.
                TextButton(onClick = { model.openChatSearch() }) {
                    Icon(
                        VeltaIcons.search,
                        contentDescription = L.t("Search in chat"),
                        modifier = Modifier.size(22.dp),
                        tint = Velta.tokens.text,
                    )
                }
                // app.js bindChatHeadMenu + bindMenuToggle: the ⋮ opens the
                // chat menu under its right edge (r.right - 220, r.bottom + 6)
                // and turns into a close (X) while the menu is open.
                var menuBtn by remember { mutableStateOf(androidx.compose.ui.geometry.Rect.Zero) }
                val headOpen = model.chatMenu?.head == true
                val pad = with(LocalDensity.current) { 220.dp.toPx() to 6.dp.toPx() }
                TextButton(
                    onClick = {
                        if (headOpen) model.closeChatMenu()
                        else model.openChatHeadMenu(menuBtn.right - pad.first, menuBtn.bottom + pad.second)
                    },
                    modifier = Modifier.onGloballyPositioned { menuBtn = it.boundsInWindow() },
                ) {
                    Icon(
                        if (headOpen) VeltaIcons.close else VeltaIcons.dotsVertical,
                        contentDescription = if (headOpen) L.t("Close menu") else L.t("Chat menu"),
                        modifier = Modifier.size(22.dp),
                        tint = Velta.tokens.text,
                    )
                }
            }
            // Stable #pinned-bar: the tray sits between the head and the history.
            PinTrayBar(model)
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
                Composer(model)
            }
        }
        // Stable #btn-go-down: away from the newest message, the way back
        // (with the unread count); a tap catches up and jumps to the newest.
        if (!atBottom && model.openScroll == null) {
            GoDownButton(
                count = model.goDownCount,
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 16.dp, bottom = with(density) { footPx.toDp() } + 12.dp),
            ) {
                model.catchUp()
                goDownScope.launch {
                    val n = chatRows(model.chatMessages, model.unreadLineId).size
                    if (n > 0) listState.animateScrollToItem(n - 1)
                }
            }
        }
        ToastHost(
            model,
            Modifier.align(Alignment.BottomCenter).padding(bottom = with(density) { footPx.toDp() }),
        )
        },
    )
    // Long-press sheet + the flows its items open (#334 step 5).
    MessageSheetHost(model)
    ForwardPicker(model) { item, onClick -> ContactLikeChatRow(item, subSize = 14.sp, onClick = onClick) }
    MessageInfoDialog(model) { id -> model.senderNames[id]?.name }
    SelectTextDialog(model)
    DeleteMessagesDialog(model)
}

/** Stable chat-view.js `_refreshPinnedBar` + main.css `.pin-tray`: the
 *  collapsed summary shows the newest pin (pin icon, bold sender, snippet,
 *  count pill for 2+, chevron); expanded, every pin newest first, each with
 *  an ✕ where the user may unpin. A row tap collapses and jumps. */
@Composable
private fun PinTrayBar(model: AppModel) {
    val tray = pinTrayOf(model.pinnedMessages, L.t("You")) ?: return
    val tokens = Velta.tokens
    val canUnpin = canUnpinInTray(model.sheetChat)
    val open = model.pinTrayOpen
    val maxListPx = androidx.compose.ui.platform.LocalWindowInfo.current.containerSize.height * 0.40f
    val maxList = with(LocalDensity.current) { maxListPx.toDp() }
    Column(
        Modifier
            .fillMaxWidth()
            .background(tokens.bgSidebar)
            .drawBehind {
                drawRect(tokens.border, topLeft = androidx.compose.ui.geometry.Offset(0f, size.height - 1.dp.toPx()), size = androidx.compose.ui.geometry.Size(size.width, 1.dp.toPx()))
            },
    ) {
        val summaryInteraction = remember { MutableInteractionSource() }
        Row(
            Modifier
                .rowSurface(summaryInteraction, hover = false)
                .fillMaxWidth()
                .clickable(
                    interactionSource = summaryInteraction,
                    indication = null,
                ) { model.pinTrayOpen = !open }
                .padding(horizontal = 14.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(VeltaIcons.pin, contentDescription = null, modifier = Modifier.size(tokens.ico1), tint = tokens.accent)
            Spacer(Modifier.size(8.dp))
            PinRowText(tray.newest, Modifier.weight(1f))
            tray.count?.let { n ->
                Spacer(Modifier.size(8.dp))
                Box(
                    Modifier
                        .defaultMinSize(minWidth = 18.dp, minHeight = 18.dp)
                        .clip(RoundedCornerShape(9.dp))
                        .background(tokens.accent)
                        .padding(horizontal = 4.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(n, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = tokens.onAccent)
                }
            }
            Spacer(Modifier.size(8.dp))
            Icon(
                VeltaIcons.chevronDown,
                contentDescription = null,
                modifier = Modifier.size(tokens.ico2).graphicsLayer { rotationZ = if (open) 180f else 0f },
                tint = tokens.textDim,
            )
        }
        if (open) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = maxList)
                    .drawBehind { drawRect(tokens.border, size = androidx.compose.ui.geometry.Size(size.width, 1.dp.toPx())) }
                    .verticalScroll(rememberScrollState()),
            ) {
                for (row in tray.rows) {
                    val interaction = remember(row.id) { MutableInteractionSource() }
                    Row(
                        Modifier
                            .rowSurface(interaction)
                            .fillMaxWidth()
                            .clickable(interactionSource = interaction, indication = null) { model.openPinned(row.id) }
                            .padding(horizontal = 14.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        PinRowText(row, Modifier.weight(1f))
                        if (canUnpin) {
                            Spacer(Modifier.size(8.dp))
                            Box(
                                Modifier
                                    .size(24.dp)
                                    .clip(RoundedCornerShape(6.dp))
                                    .clickable(onClickLabel = L.t("Unpin")) { model.unpinFromTray(row.id) },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(VeltaIcons.close, contentDescription = L.t("Unpin"), modifier = Modifier.size(tokens.ico1), tint = tokens.textDim)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Stable `.unread-sep`: accent text over a 1px accent rule; light theme
 *  uses #155a9e (the accent misses AA on the light chat background). */
@Composable
private fun UnreadSeparator() {
    val light = LocalVeltaThemeMode.current == VeltaThemeMode.Light
    val ink = if (light) androidx.compose.ui.graphics.Color(0xFF155A9E) else Velta.tokens.accent
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 10.dp)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(ink))
        Text(
            L.t("Unread messages"),
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            fontSize = 13.sp,
            color = ink,
        )
    }
}

/** Stable `.go-down` (52dp bgSidebar disc, shadow, chevronDown in textDim)
 *  + `.go-down-badge` (accent pill, onAccent 12sp/600, top/right −5). */
@Composable
private fun GoDownButton(count: Int, modifier: Modifier, onClick: () -> Unit) {
    val tokens = Velta.tokens
    Box(modifier.size(58.dp), contentAlignment = Alignment.BottomStart) {
        Box(
            Modifier
                .size(52.dp)
                .shadow(4.dp, CircleShape)
                .clip(CircleShape)
                .background(tokens.bgSidebar)
                .clickable(onClickLabel = L.t("Scroll to bottom"), onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            Icon(VeltaIcons.chevronDown, contentDescription = L.t("Scroll to bottom"), modifier = Modifier.size(tokens.ico4), tint = tokens.textDim)
        }
        goDownBadge(count)?.let { text ->
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .defaultMinSize(minWidth = 22.dp, minHeight = 22.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(tokens.accent)
                    .padding(horizontal = 4.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = tokens.onAccent)
            }
        }
    }
}

/** `.pb-text`: bold sender in --text, then the snippet in --text-dim, one line. */
@Composable
private fun PinRowText(row: PinRow, modifier: Modifier) {
    val tokens = Velta.tokens
    Text(
        androidx.compose.ui.text.buildAnnotatedString {
            pushStyle(androidx.compose.ui.text.SpanStyle(color = tokens.text, fontWeight = FontWeight.SemiBold))
            append(row.name)
            pop()
            append(" ")
            append(row.snippet)
        },
        modifier = modifier,
        fontSize = 13.sp,
        color = tokens.textDim,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/** Web velta-chat-head statusLine: per-kind subtitle under the name.
 *  Typing indicators ride #332; the online flag has no KMP contact field. */
private fun chatHeadStatus(head: AppModel.ChatHead?): String? {
    head ?: return null
    return when (head.kind) {
        "saved" -> L.t("your personal space")
        "device" -> L.t("local device messages")
        "group" -> head.memberCount?.let { n -> L.t("{n} members").replace("{n}", n.toString()) }
        "channel" -> head.memberCount?.let { n -> L.t("{n} subscribers").replace("{n}", n.toString()) }
        else -> when {
            head.isBot -> L.t("bot")
            (head.lastSeen ?: 0L) > 0L ->
                L.t("last seen {when}").replace("{when}", relativeLastSeen(head.lastSeen ?: 0L))
            else -> null
        }
    }
}

/** Group messages by local calendar date, inserting a header where the day changes. */
private fun chatRows(messages: List<MessageObject>, unreadLineId: Long? = null): List<ChatRow> {
    val rows = mutableListOf<ChatRow>()
    var lastDay: String? = null
    for (message in messages) {
        val day = formatDateHeader(message.timestamp)
        if (day != lastDay) {
            rows += ChatRow.Header(day)
            lastDay = day
        }
        // Stable .unread-sep rides above the first unread message, under its day chip.
        if (message.id == unreadLineId) rows += ChatRow.UnreadSep
        rows += ChatRow.Message(message)
    }
    return rows
}

@Composable
private fun DayHeader(text: String) {
    val tokens = Velta.tokens
    // Web .day-chip: 13px on #1c1c22 (dark) / #f4f4f4 (light), 14px radius,
    // 12px above / 6px below (the 4dp list gap adds the rest).
    Box(
        Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        // Brutal (main.css .day-chip override): 2px ink border, 6px radius,
        // --bg-sidebar fill and a hard 2px offset ink shadow.
        val brutal = LocalVeltaThemeMode.current == VeltaThemeMode.Brutal
        val chipShape = RoundedCornerShape(if (brutal) 6.dp else 14.dp)
        Text(
            text,
            fontSize = 13.sp,
            color = if (tokens.isDark) Color(0xFFD7D7DE) else Color(0xFF5D636E),
            modifier = if (brutal) {
                Modifier
                    .drawBehind {
                        val r = 6.dp.toPx()
                        val o = 2.dp.toPx()
                        drawRoundRect(
                            Color(0xFF121017),
                            topLeft = androidx.compose.ui.geometry.Offset(o, o),
                            size = size,
                            cornerRadius = androidx.compose.ui.geometry.CornerRadius(r, r),
                        )
                    }
                    .background(tokens.bgSidebar, chipShape)
                    .border(2.dp, Color(0xFF121017), chipShape)
                    .padding(horizontal = 12.dp, vertical = 4.dp)
            } else {
                Modifier
                    .shadow(if (tokens.isDark) 0.dp else 2.dp, chipShape)
                    .background(
                        if (tokens.isDark) Color(0xFF1C1C22) else Color(0xFFF4F4F4),
                        chipShape,
                    )
                    .padding(horizontal = 12.dp, vertical = 4.dp)
            },
        )
    }
}

/** Web .service-msg: monospace system message pill, centered — not a bubble.
 *  Dark = #d7d7de on black-28%; light flips to a white-80% pill with #464b55
 *  ink (main.css:855 — the dark pairing is 1.56:1 on the light canvas). */
@Composable
private fun ServiceMessage(message: MessageObject) {
    val tokens = Velta.tokens
    val bg = if (tokens.isDark) Color(0x47101016) else Color(0xCCF4F4F4)
    val fg = if (tokens.isDark) Color(0xFFD7D7DE) else Color(0xFF464B55)
    Box(Modifier.fillMaxWidth().padding(vertical = 3.dp), contentAlignment = Alignment.Center) {
        Text(
            message.text,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.5.sp,
            lineHeight = (12.5f * 1.5f).sp,
            color = fg,
            modifier = Modifier
                .background(bg, RoundedCornerShape(10.dp))
                .padding(horizontal = 12.dp, vertical = 4.dp),
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

/** app.js formatEphemeralTimer — "After 1 week" / "On (45 s)" / "Off". */
private fun ephemeralTimerLabel(secs: Int): String {
    val (key, n) = ephemeralTimerKey(secs)
    return if (n != null) L.t(key).replace("{n}", n.toString()) else L.t(key)
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
        // Stable toast()/errToast() lines (profile editor results).
        bottomBar = { ToastHost(model) },
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
            if (showsEditProfile(p.contactId)) {
                TextButton(onClick = { model.openProfileEditor() }) { Text(L.t("Edit profile")) }
            }
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
            GroupManageBlock(model, p)
            profileRows(model, p)
            Spacer(Modifier.size(24.dp))
        }
    }
}

/** #334 step 11: rename, members, add / remove. Full list — virtualize if a group passes a few hundred. */
@Composable
private fun GroupManageBlock(model: AppModel, p: AppModel.ProfileData) {
    val kind = stableChatKind(p.isSelfTalk, p.isDeviceTalk, false, p.chatType)
    if (!canRename(kind) && kind != "group") return
    val menu = MenuChat(p.chatId, p.chatName, kind, p.chatType, groupAdminId = p.groupAdminId)
    Column(Modifier.fillMaxWidth()) {
        if (canRename(kind)) {
            TextButton(onClick = { model.beginRename() }, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                Text(L.t("Rename"))
            }
        }
        if (kind == "group") {
            Text(
                L.t("Members"),
                style = MaterialTheme.typography.labelMedium,
                color = Velta.tokens.textDim,
                modifier = Modifier.padding(top = 8.dp, bottom = 4.dp).align(Alignment.Start),
            )
            val members = model.chatMembers[p.chatId].orEmpty()
            members.forEach { m ->
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AvatarTile(
                        name = m.name,
                        colorHex = m.color,
                        kind = "single",
                        size = 36.dp,
                        identityFpr = m.fingerprint,
                        avatarPath = m.avatarPath,
                    )
                    Spacer(Modifier.size(10.dp))
                    Text(m.name, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (canRemoveMember(menu, m.id)) {
                        TextButton(onClick = { model.askRemoveMember(m) }) { Text(L.t("Remove member")) }
                    }
                }
            }
            if (canAddMembers(menu)) {
                TextButton(onClick = { model.startAddMembers() }) { Text(L.t("Add members")) }
            }
        }
        HorizontalDivider()
    }
}

/** Stable ui.js showEditProfile: 84dp avatar preview (18% radius), Change
 *  picture / Remove photo, name (max 64, "Your name" hint), description
 *  textarea, Cancel / Save. */
@Composable
private fun ProfileEditorDialog(model: AppModel) {
    val ed = model.profileEditor ?: return
    VeltaDialog(
        title = L.t("Edit profile"),
        confirmLabel = L.t("Save"),
        onConfirm = { model.saveProfileEditor() },
        onDismiss = { model.closeProfileEditor() },
        confirmEnabled = !ed.busy,
    ) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.padding(top = 6.dp, bottom = 2.dp)) {
                AvatarTile(
                    name = ed.name.ifBlank { "?" },
                    colorHex = ed.color,
                    kind = "single",
                    size = 84.dp,
                    avatarPath = previewAvatar(ed.currentAvatar, ed.picked, ed.removed),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                TextButton(onClick = { model.pickProfilePhoto() }, enabled = !ed.busy) { Text(L.t("Change picture")) }
                if (showsRemovePhoto(ed.currentAvatar, ed.picked, ed.removed)) {
                    TextButton(onClick = { model.removeProfilePhoto() }, enabled = !ed.busy) { Text(L.t("Remove photo")) }
                }
            }
            OutlinedTextField(
                value = ed.name,
                onValueChange = { model.editProfileName(it) },
                singleLine = true,
                enabled = !ed.busy,
                placeholder = { Text(L.t("Your name")) },
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = L.t("Name") },
            )
            Spacer(Modifier.size(8.dp))
            OutlinedTextField(
                value = ed.description,
                onValueChange = { model.editProfileDescription(it) },
                minLines = 3,
                enabled = !ed.busy,
                placeholder = { Text(L.t("Description")) },
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = L.t("Description") },
            )
            ed.error?.let {
                Spacer(Modifier.size(8.dp))
                Text(it, fontSize = 13.sp, color = Velta.tokens.danger)
            }
        }
    }
}

/** Stable openEphemeralDialog: radios over EPHEMERAL_OPTIONS, the note,
 *  Cancel / OK (OK applies via the core, which posts its own notice). */
@Composable
private fun EphemeralDialog(model: AppModel) {
    val draft = model.ephemeralDraft ?: return
    VeltaDialog(
        title = L.t("Disappearing messages"),
        confirmLabel = L.t("OK"),
        onConfirm = { model.applyEphemeral() },
        onDismiss = { model.closeEphemeralDialog() },
    ) {
        Column(Modifier.selectableGroup()) {
            for ((label, secs) in EPHEMERAL_OPTIONS) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .selectable(
                            selected = draft.selected == secs,
                            role = androidx.compose.ui.semantics.Role.RadioButton,
                        ) { model.pickEphemeral(secs) }
                        .padding(vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = draft.selected == secs, onClick = null)
                    Spacer(Modifier.size(8.dp))
                    Text(L.t(label), color = Velta.tokens.text)
                }
            }
        }
        Spacer(Modifier.size(8.dp))
        Text(L.t(EPHEMERAL_NOTE), fontSize = 13.sp, color = Velta.tokens.textDim)
        model.ephemeralError?.let {
            Spacer(Modifier.size(8.dp))
            Text(it, fontSize = 13.sp, color = Velta.tokens.danger)
        }
    }
}

/** The contact-sheet data rows (media counts, address, key, timers). */
@Composable
private fun profileRows(model: AppModel, p: AppModel.ProfileData) {
    val kind = stableChatKind(p.isSelfTalk, p.isDeviceTalk, false, p.chatType)
    val ephKey = L.t("Disappearing messages")
    val rows = buildList {
        add(L.t("Apps") to p.apps.toString())
        add(L.t("Photos") to p.photos.toString())
        add(L.t("Videos") to p.videos.toString())
        add(L.t("Audio") to p.audio.toString())
        add(L.t("Files") to p.files.toString())
        if (p.addr.isNotEmpty()) add(L.t("Address") to p.addr)
        p.fingerprint?.let { add(L.t("Profile key") to groupedFpr(it)) }
        add(L.t("Last seen") to relativeLastSeen(p.lastSeenSeconds))
        add(L.t("Notifications") to if (p.muted) L.t("Off") else L.t("On"))
        // Stable showChatInfo: groups and 1:1 chats only; admin-only in admin groups.
        if (showsEphemeralRow(kind)) add(ephKey to ephemeralTimerLabel(p.ephemeralSecs))
    }
    val canSetTimer = canSetEphemeral(kind, p.groupAdminId)
    rows.forEach { (k, v) ->
        val eph = k == ephKey
        Row(
            Modifier
                .fillMaxWidth()
                .then(
                    when {
                        eph && canSetTimer -> Modifier.clickable { model.openEphemeralDialog() }
                        eph -> Modifier.semantics {
                            disabled()
                            stateDescription = L.t(EPHEMERAL_ADMIN_ONLY)
                        }
                        else -> Modifier
                    },
                )
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

@Composable
private fun Composer(model: AppModel) {
    val reply = model.replyTo
    val editing = model.editingMsg
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
        // Stable #reply-preview in edit mode: "Editing message" + the text.
        if (editing != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    VeltaIcons.edit,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.size(6.dp))
                Column(Modifier.weight(1f)) {
                    Text(L.t("Editing message"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, maxLines = 1)
                    Text(editing.text.take(60), style = MaterialTheme.typography.labelMedium, color = Velta.tokens.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                TextButton(onClick = { model.cancelEdit() }) { Icon(VeltaIcons.close, contentDescription = L.t("Close")) }
            }
        }
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
        model.voiceRec?.let { rec -> VoiceRecBar(model, rec) }
        model.sendError?.let {
            Text(
                L.t("Send failed") + ": " + it,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.labelSmall,
            )
        }
        val openChat = model.screen as? AppModel.Screen.Chat
        val mentionQ = if (openChat?.isGroup == true) mentionQuery(model.composerText) else null
        val mentionMembers = if (openChat != null) model.chatMembers[openChat.chatId].orEmpty() else emptyList()
        val mentionPicks = if (mentionQ == null) emptyList() else {
            val others = mentionMembers.count { it.id != 1L }
            if (mentionQ.query.isEmpty() && others > BARE_AT_MAX) emptyList()
            else filterMembers(mentionMembers, mentionQ.query)
        }
        if (mentionPicks.isNotEmpty()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(bottom = 4.dp)
                    .background(Velta.tokens.bgSidebar, RoundedCornerShape(12.dp))
                    .border(1.dp, Velta.tokens.border, RoundedCornerShape(12.dp)),
            ) {
                mentionPicks.forEach { member ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { model.insertMention(member) }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(member.name, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (member.code.isNotEmpty()) {
                            Text(member.code, color = Velta.tokens.textDim, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
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
                    voiceAvailable = model.voiceRecorder != null,
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
                    onVoice = {
                        showAttachMenu = false
                        model.startVoice()
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
                // Stable: while recording, Send stops and sends the voice message.
                val recording = model.voiceRec != null
                IconButton(
                    onClick = { if (recording) model.stopVoice(true) else model.send() },
                    enabled = recording || !model.sending &&
                        (model.composerText.isNotBlank() || model.pendingAttachment != null),
                    modifier = Modifier.size(48.dp),
                ) {
                    Icon(
                        VeltaIcons.send,
                        contentDescription = L.t("Send"),
                        modifier = Modifier.size(26.dp),
                        tint = if (!recording && (model.sending || (model.composerText.isBlank() && model.pendingAttachment == null))) {
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
    voiceAvailable: Boolean,
    onDismiss: () -> Unit,
    onPick: (AppModel.AttachKind) -> Unit,
    onStickers: () -> Unit,
    onCamera: () -> Unit,
    onVoice: () -> Unit,
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
                if (voiceAvailable) {
                    AttachMenuItem(VeltaIcons.mic, L.t("Voice message")) { onDismiss(); onVoice() }
                }
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
                    htmlBreaks(L.t("No stickers yet.<br>Long-press a sticker you received and choose “Save sticker”.")),
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

/** Web .invite-card: the text joins, the icons copy and share the link. */
@Composable
private fun InviteCard(
    title: String,
    sub: String,
    link: String,
    model: AppModel,
    onJoin: () -> Unit,
) {
    val dark = isSystemInDarkTheme()
    val bg = if (dark) Color(0x0FF4F4F4) else Color(0x0D101010)
    val clipboard = LocalClipboardManager.current
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 5.dp)
            .background(bg, RoundedCornerShape(10.dp))
            .border(1.dp, Velta.tokens.border, RoundedCornerShape(10.dp)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            Modifier
                .weight(1f)
                .clickable(onClick = onJoin)
                .padding(start = 10.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        ) {
            Text(
                title,
                fontWeight = FontWeight.SemiBold,
                fontSize = 15.sp,
                lineHeight = (15f * 1.35f).sp,
                color = Velta.tokens.text,
            )
            if (sub.isNotEmpty()) {
                Text(
                    sub,
                    fontSize = 13.sp,
                    color = Velta.tokens.textDim,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Icon(
            VeltaIcons.copy,
            contentDescription = L.t("Copy invite link"),
            modifier = Modifier
                .size(36.dp)
                .clickable {
                    clipboard.setText(AnnotatedString(link))
                    model.showToast(L.t("Invite link copied"))
                }
                .padding(7.dp),
            tint = Velta.tokens.textDim,
        )
        if (model.shareText != null) {
            Icon(
                VeltaIcons.share,
                contentDescription = L.t("Share invite link"),
                modifier = Modifier
                    .size(36.dp)
                    .clickable { model.shareText?.invoke(link) }
                    .padding(7.dp),
                tint = Velta.tokens.textDim,
            )
        }
        Icon(
            VeltaIcons.chevronRight,
            contentDescription = null,
            modifier = Modifier.size(22.dp).clickable(onClick = onJoin),
            tint = Velta.tokens.textDim,
        )
        Spacer(Modifier.size(6.dp))
    }
}

private val MEDIA_VIEWTYPES = setOf("Image", "Gif", "Sticker")

/** Stable GESTURE_SKIP_SELECTOR (button, input, audio): a touch that
 *  starts here never becomes a reply or back swipe. Runs after the
 *  parents' down handlers (Initial pass goes parent → child), before any
 *  move reaches them. */
private fun Modifier.gestureSkip(model: AppModel): Modifier = pointerInput(Unit) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        model.gestureSkipDown = true
    }
}

/** A bubble tap target with no ripple (stable media/file cards). The
 *  bubble's own gesture loop consumes long-press and select taps, so
 *  those never reach here. */
private fun Modifier.tapOpens(onTap: () -> Unit): Modifier = composed {
    clickable(
        interactionSource = remember { MutableInteractionSource() },
        indication = null,
        role = androidx.compose.ui.semantics.Role.Button,
        onClick = onTap,
    )
}

@Composable
private fun MessageBubble(
    message: MessageObject,
    sender: SenderFace?,
    members: List<MentionMember>,
    model: AppModel,
) {
    val outgoing = message.fromId == 1L // ContactId.SELF
    val clipboard = LocalClipboardManager.current
    val uriHandler = LocalUriHandler.current
    val tokens = Velta.tokens
    // .bubble CSS: radius 14px, the tail corner drops to 6px on the sender
    // side; padding 7px 10px 6px; 1px shadow; tokens bgBubbleIn/Out. Stickers
    // strip the fill entirely (.bubble.sticker: transparent, no shadow, no
    // padding, image capped at 175px).
    val sticker = message.viewType == "Sticker" && message.file != null &&
        (message.downloadState ?: "Done") == "Done" && !model.attachmentCovered(message)
    val bubbleShape = RoundedCornerShape(
        topStart = tokens.radiusBubble,
        topEnd = tokens.radiusBubble,
        bottomStart = if (outgoing) tokens.radiusBubble else tokens.radiusTail,
        bottomEnd = if (outgoing) tokens.radiusTail else tokens.radiusBubble,
    )
    // Web .q-text palettes (main.css 907-912, 3393): measured WCAG per
    // bubble — dark/amoled in #9aa3b5 / out #cfe0f2; light inks BOTH sides
    // to #4d5a68 (the light-on-blue out pair measured 1.05:1); brutal inks
    // the yellow-bubble out quote down to #3d3410.
    val themeMode = LocalVeltaThemeMode.current
    val quoteText = when {
        themeMode == VeltaThemeMode.Light -> Color(0xFF4D5A68)
        outgoing && themeMode == VeltaThemeMode.Brutal -> Color(0xFF3D3410)
        outgoing -> Color(0xFFCFE0F2)
        else -> Color(0xFF9AA3B5)
    }
    // Web reply swipe (chat-view.js:3035-3110): drag the bubble rightward —
    // engages at 12dp, ticks at the 48dp commit line, and a release past the
    // line opens the reply draft. KMP polish: rubber-band past the line, a
    // reply arrow that fades/grows in the gap and pops at the line, and a
    // spring home (all flat under reduced motion).
    val haptics = LocalHapticFeedback.current
    val reply = remember(message.id) { SwipeOffset() }
    val replyPop = remember(message.id) { SwipeOffset().also { it.value = 1f } }
    val replyScope = rememberCoroutineScope()
    val replyFancy = !rememberReducedMotion()
    val replyArrow = androidx.compose.ui.graphics.vector.rememberVectorPainter(VeltaIcons.reply)
    val replyCommitPx = with(LocalDensity.current) { SwipeSpec.REPLY_COMMIT_DP.dp.toPx() }
    val quoteName = if (outgoing) tokens.quoteNameOut else tokens.quoteName
    val quoteBg = tokens.bgReply
    // Web .msg-meta: 11.5px in --text-meta-in/--text-meta-out; ticks read
    // --ticks-read, failures --danger, everything else rides the meta color.
    val metaColor = if (outgoing) tokens.textMetaOut else tokens.textMetaIn
    // #334 step 5 — stable row gestures (chat-view.js:3053-3130): a 500 ms
    // long-press opens the message sheet (the link under the finger rides
    // along); a rightward drag is swipe-to-reply; in selection mode a tap
    // toggles the row. A plain tap does nothing on the bubble itself.
    val selectionMode = model.selection.isNotEmpty()
    val selected = message.id in model.selection
    val held = message.id in model.deleteHolds
    val tomb = message.id in model.tombstones
    val pressHref = remember(message.id) { arrayOf("") }
    var bubbleH by remember(message.id) { mutableIntStateOf(0) }
    val density = LocalDensity.current
    val viewConfig = LocalViewConfiguration.current
    val liveSelection by rememberUpdatedState(selectionMode)
    val liveHeld by rememberUpdatedState(held)
    val actionsLabel = L.t("Message actions")
    val gestures = Modifier.pointerInput(message.id) {
        val engage = SwipeSpec.ENGAGE_DP.dp.toPx()
        val commit = SwipeSpec.REPLY_COMMIT_DP.dp.toPx()
        val extra = SwipeSpec.REPLY_RUBBER_DP.dp.toPx()
        val slop = viewConfig.touchSlop
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            pressHref[0] = ""
            // Grab a bubble that is still springing home.
            val base = reply.value
            reply.stop()
            var lastUptime = down.uptimeMillis
            var swipeOk = touchGesturesEnabled && !liveSelection && !liveHeld && !model.sheetChat.readOnly
            var engaged = false
            var moved = false
            var longPressed = false
            var rawDx = base
            var dyc = 0f
            var past = false
            fun release(commitIt: Boolean) {
                model.replySwipeActive = false
                if (commitIt) model.startReply(message)
                reply.settle(replyScope, 0f, replyFancy)
            }
            while (true) {
                val event = if (!longPressed && !moved && !engaged) {
                    val left = (LONG_PRESS_MS - (lastUptime - down.uptimeMillis)).coerceAtLeast(1L)
                    withTimeoutOrNull(left) { awaitPointerEvent(PointerEventPass.Initial) }
                } else {
                    awaitPointerEvent(PointerEventPass.Initial)
                }
                if (event == null) {
                    longPressed = true
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    model.openMessageSheet(message, pressHref[0])
                    continue
                }
                event.changes.firstOrNull()?.let { lastUptime = it.uptimeMillis }
                // A second finger never means long-press or reply (web touchstart).
                if (event.changes.size > 1) {
                    moved = true
                    swipeOk = false
                    if (engaged) { engaged = false; release(false) }
                }
                val change = event.changes.firstOrNull()
                if (event.changes.none { it.pressed } || change == null) {
                    // A cancel (system took the touch) arrives pre-consumed.
                    val cancelled = event.changes.all { it.isConsumed }
                    when {
                        // The sheet is up: the lift must not also tap a link.
                        longPressed -> event.changes.forEach { it.consume() }
                        !moved && !engaged && liveSelection && !cancelled -> {
                            event.changes.forEach { it.consume() }
                            model.toggleSelect(message.id)
                        }
                    }
                    // Release past the commit line opens the reply draft
                    // (web endReplySwipe(true)); either way the bubble springs home.
                    if (engaged) release(releaseCommits(rawDx, commit, cancelled))
                    else if (reply.value != 0f) reply.settle(replyScope, 0f, replyFancy)
                    break
                }
                if (longPressed) {
                    event.changes.forEach { it.consume() }
                    continue
                }
                // Deltas, not positions: the bubble moves under the finger.
                rawDx += change.position.x - change.previousPosition.x
                dyc += change.position.y - change.previousPosition.y
                val dxc = rawDx - base
                if (!moved && (Math.abs(dxc) > slop || Math.abs(dyc) > slop)) moved = true
                if (!swipeOk) continue
                if (!engaged) {
                    if (!replySwipeAllowed(model.backSwipeActive, model.gestureEdgeDown, model.gestureSkipDown)) {
                        swipeOk = false
                        if (reply.value != 0f) reply.settle(replyScope, 0f, replyFancy)
                        continue
                    }
                    when (swipeAxis(dxc, dyc, engage, positive = true)) {
                        SwipeAxis.Vertical -> {
                            swipeOk = false
                            if (reply.value != 0f) reply.settle(replyScope, 0f, replyFancy)
                            continue
                        }
                        SwipeAxis.Undecided -> if (base == 0f) continue
                        SwipeAxis.Horizontal -> Unit
                    }
                    engaged = true
                    model.replySwipeActive = true
                }
                reply.value = replyFollow(rawDx, commit, extra, replyFancy)
                val t = thresholdTick(past, rawDx, commit)
                past = t.past
                if (t.tick) {
                    haptics.performHapticFeedback(HapticFeedbackType.GestureThresholdActivate)
                    if (replyFancy) {
                        replyPop.snapTo(SwipeSpec.ARROW_POP_SCALE)
                        replyPop.settle(replyScope, 1f, fancy = true)
                    }
                }
                event.changes.forEach { it.consume() }
            }
        }
    }.semantics {
        // TalkBack: the long-press menu as a custom action.
        onLongClick(label = actionsLabel) { model.openMessageSheet(message); true }
    }
    // .msg-row.selected: accent 16% across the row; the checkbox leads.
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (selected || model.flashMsgId == message.id) tokens.accent.copy(alpha = 0.16f) else Color.Transparent)
            .then(
                if (selectionMode) {
                    Modifier.clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                    ) { model.toggleSelect(message.id) }
                } else Modifier,
            ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
    if (selectionMode) {
        Spacer(Modifier.size(4.dp))
        SelectCheck(selected)
        Spacer(Modifier.size(8.dp))
    }
    BoxWithConstraints(Modifier.weight(1f)) {
    // Stable .msg-row is full width (.out: flex-end), the BUBBLE caps at
    // min(480px, 90%) (- 50px with the avatar) — #334 bug 13.
    val bubbleMax = bubbleMaxWidth(maxWidth.value, withAvatar = sender != null).dp
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start,
        verticalAlignment = if (sender != null) Alignment.Bottom else Alignment.Top,
    ) {
        if (sender != null) {
            MessageAvatar(sender)
            Spacer(Modifier.size(8.dp))
        }
        Column(Modifier.widthIn(max = bubbleMax), horizontalAlignment = if (outgoing) Alignment.End else Alignment.Start) {
            if (held || tomb) {
                Box(gestures) {
                    DeletedBubble(
                        model = model,
                        message = message,
                        outgoing = outgoing,
                        minHeight = with(density) { bubbleH.toDp() },
                        shape = bubbleShape,
                    )
                }
                return@Column
            }
            Surface(
                color = when {
                    sticker -> Color.Transparent
                    outgoing -> tokens.bgBubbleOut
                    else -> tokens.bgBubbleIn
                },
                // Stable .bubble sets no color, so bubble text inherits
                // --text (brutal out: --nb-main-ink). Without an explicit
                // contentColor, Material matched bgBubbleIn == bgElev
                // (surfaceVariant) and painted incoming text in
                // onSurfaceVariant = --text-dim in dark/AMOLED/brutal.
                contentColor = if (outgoing) tokens.textOut else tokens.text,
                shape = bubbleShape,
                shadowElevation = if (sticker) 0.dp else 1.dp,
                modifier = Modifier
                    .widthIn(max = bubbleMax)
                    .heightIn(min = 20.dp)
                    .onSizeChanged { bubbleH = it.height }
                    .replyArrowBehind(
                        dx = { reply.value },
                        commitPx = replyCommitPx,
                        pop = { replyPop.value },
                        painter = replyArrow,
                        // Past the line the disc fills with accent and the
                        // arrow takes onAccent (the AA pair for accent fills).
                        disc = { if (reply.value >= replyCommitPx) tokens.accent else tokens.bgBubbleIn },
                        tint = { if (reply.value >= replyCommitPx) tokens.onAccent else tokens.textDim },
                        discPx = with(density) { 32.dp.toPx() },
                        iconPx = with(density) { 18.dp.toPx() },
                    )
                    .graphicsLayer { translationX = reply.value }
                    .then(gestures),
            ) {
                Column(
                    Modifier.padding(
                        if (sticker) PaddingValues(0.dp)
                        else PaddingValues(start = 10.dp, end = 10.dp, top = 7.dp, bottom = 6.dp),
                    ),
                ) {
                    if (sender != null) {
                        // Web .msg-sender: 13.5px, semibold, person color —
                        // lives INSIDE the bubble (stickers included; the
                        // transparent bubble lets it float).
                        Text(
                            sender.name,
                            fontSize = 13.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = prismSenderColor(
                                sender.name,
                                tokens.bgBubbleIn,
                                sender.colorHex,
                                lighten = themeMode != VeltaThemeMode.Light,
                            ),
                            modifier = Modifier.padding(bottom = 2.dp),
                        )
                    }
                    // .msg-quote: 2.5dp accent bar, quote radius, name + one line.
                    message.quote?.let { quote ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .height(IntrinsicSize.Min)
                                .padding(bottom = 5.dp)
                                .background(quoteBg, RoundedCornerShape(tokens.radiusQuote))
                                .clickable { model.jumpToQuoted(quote.messageId) },
                        ) {
                            Box(
                                Modifier
                                    .width(2.5.dp)
                                    .fillMaxHeight()
                                    .background(tokens.accent),
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
                    // Text-only mode hides the attachment behind a card; media not
                    // on the device yet gets stable's download card.
                    val covered = model.attachmentCovered(message)
                    val needsDownload = !covered && needsDownloadCard(message)
                    val mediaShown = !covered && !needsDownload &&
                        message.viewType in MEDIA_VIEWTYPES && message.file != null
                    if (covered) {
                        HiddenAttachmentCard(model, message, tokens, if (outgoing) quoteName else tokens.accent)
                    } else if (needsDownload) {
                        Box(Modifier.tapOpens { model.downloadMedia(message) }) { DownloadCard(message, tokens) }
                    } else if (mediaShown) {
                        MediaFromDisk(
                            message.file!!,
                            message.dimensionsWidth,
                            message.dimensionsHeight,
                            sticker = message.viewType == "Sticker",
                            modifier = (if (message.viewType == "Sticker") Modifier else Modifier.mediaBleed())
                                .tapOpens { model.tapMedia(message) },
                        )
                    } else when (message.viewType) {
                        // Web .msg-video: #101010 band with a play button and
                        // size/duration chips; a tap hands the file to the system player.
                        "Video" -> Box(Modifier.tapOpens { model.tapVideo(message) }) { VideoCard(message, tokens) }
                        // Web .msg-audio: stable's own player bar (audio-player.js).
                        "Audio", "Voice" -> AudioBubble(model, message, tokens)
                        // Web .msg-file: 44px accent circle + name + size; a tap opens it.
                        "File" -> Box(Modifier.tapOpens { model.openMessageFile(message) }) { FileCard(message, tokens) }
                        "Webxdc" -> FileCard(message, tokens)
                        else -> {}
                    }
                    if (message.text.isNotBlank()) {
                        val annotated = markdownAnnotated(
                            message.text,
                            accent = if (outgoing) quoteName else tokens.accent,
                            codeBackground = quoteBg,
                            textColor = tokens.text,
                            members = members,
                        )
                        var textLayout by remember { mutableStateOf<TextLayoutResult?>(null) }
                        Text(
                            annotated,
                            fontSize = 15.5.sp,
                            lineHeight = (15.5f * VeltaType.msgLineHeight).sp,
                            onTextLayout = { textLayout = it },
                            modifier = Modifier.pointerInput(annotated) {
                                // #161: the link under the finger at touch-down
                                // targets the long-press sheet (web pressHref).
                                awaitEachGesture {
                                    val d = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                                    val layout = textLayout ?: return@awaitEachGesture
                                    val pos = layout.getOffsetForPosition(d.position)
                                    val hit = annotated.getStringAnnotations(ANN_URL, pos, pos).firstOrNull()
                                        ?: annotated.getStringAnnotations(ANN_INVITE, pos, pos).firstOrNull()
                                    if (hit != null) pressHref[0] = hit.item
                                }
                            }.pointerInput(annotated) {
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
                                    for (a in annotated.getStringAnnotations(ANN_HASHTAG, pos, pos)) {
                                        model.openChatSearch(a.item)
                                        return@detectTapGestures
                                    }
                                    for (a in annotated.getStringAnnotations(ANN_URL, pos, pos)) {
                                        // bindInviteInterception: an anchor
                                        // whose href parses as an invite
                                        // joins instead of opening the
                                        // browser (md-link invites stay
                                        // anchors — web's invite-card rule).
                                        // A deltachat.id short link expands
                                        // first, then joins.
                                        if (isShortInviteLink(a.item)) {
                                            model.expandShortInvite(a.item, thenJoin = true)
                                            return@detectTapGestures
                                        }
                                        val invite = parseInviteLink(a.item)
                                        if (invite != null) model.openInviteLink(invite)
                                        else model.openHttp?.invoke(a.item) ?: runCatching { uriHandler.openUri(a.item) }
                                        return@detectTapGestures
                                    }
                                }
                            },
                        )
                        // Invite cards ride under the text like the web's
                        // inviteCardHtml: one card per INVITE annotation.
                        annotated.getStringAnnotations(ANN_INVITE, 0, annotated.length).forEach { a ->
                            val label = inviteLabel(a.item)
                            InviteCard(label.title, label.sub, a.item, model) { model.openInviteLink(a.item) }
                        }
                        findShortInviteLinks(message.text).forEach { url ->
                            val expanded = model.shortInvites[url]
                            if (expanded == null && url !in model.shortFailed) {
                                LaunchedEffect(url) { model.expandShortInvite(url) }
                            }
                            when (val link = expanded) {
                                null -> if (url !in model.shortFailed) {
                                    InviteCard(L.t("Expanding invite…"), url, url, model) {
                                        model.expandShortInvite(url, thenJoin = true)
                                    }
                                }
                                else -> {
                                    val label = inviteLabel(link)
                                    InviteCard(label.title, label.sub, link, model) { model.openInviteLink(link) }
                                }
                            }
                        }
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.align(Alignment.End).padding(top = 2.dp),
                    ) {
                        Text(
                            formatTimestamp(message.timestamp),
                            fontSize = VeltaType.msgMetaSize,
                            color = metaColor,
                        )
                        if (outgoing) {
                            stateIcon(message.state)?.let { glyph ->
                                Spacer(Modifier.size(3.dp))
                                Icon(
                                    glyph,
                                    contentDescription = null,
                                    modifier = Modifier.size(14.dp),
                                    tint = when (message.state) {
                                        28 -> tokens.ticksRead
                                        24 -> tokens.danger
                                        else -> metaColor
                                    },
                                )
                            }
                        }
                    }
                    // Web .msg-reactions: inside the bubble, bgReply chips,
                    // the own reaction gets the accent border.
                    val reactions = reactionChips(message.reactions)
                    if (reactions.isNotEmpty() && !sticker) {
                        Spacer(Modifier.size(2.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            reactions.forEach { chip ->
                                Text(
                                    if (chip.count > 1) "${chip.emoji} ${chip.count}" else chip.emoji,
                                    fontSize = 13.sp,
                                    color = tokens.text,
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(12.dp))
                                        .background(
                                            if (chip.mine) tokens.accent.copy(alpha = 0.18f) else tokens.bgReply,
                                            RoundedCornerShape(12.dp),
                                        )
                                        .border(
                                            1.dp,
                                            if (chip.mine) tokens.accent else tokens.border,
                                            RoundedCornerShape(12.dp),
                                        )
                                        // Stable: tapping a chip toggles our reaction.
                                        .clickable(enabled = !selectionMode) { model.react(message, chip.emoji) }
                                        .padding(horizontal = 8.dp, vertical = 2.dp),
                                )
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

/** Web <velta-avatar size="42" kind="single"> for an incoming group sender. */
@Composable
private fun MessageAvatar(sender: SenderFace) {
    AvatarTile(
        name = sender.name,
        colorHex = sender.colorHex,
        kind = "single",
        size = 42.dp,
        identityFpr = sender.fingerprint,
        avatarPath = sender.avatarPath,
    )
}

/** Web .velta-video-size/.velta-video-dur chip: 12px on rgba(11,11,16,.86). */
@Composable
private fun MediaChip(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        fontSize = 12.sp,
        lineHeight = 12.sp,
        color = Color(0xFFF2F2F5),
        modifier = modifier
            .background(Color(0xDB0B0B10), RoundedCornerShape(6.dp))
            .padding(horizontal = 6.dp, vertical = 4.dp),
    )
}

/** Web .msg-video fallback band: #101010, 54px play circle, size chip
 *  top-left + duration chip bottom-right. Static — no playback engine yet. */
@Composable
private fun VideoCard(message: MessageObject, tokens: VeltaTokens) {
    Box(
        Modifier
            .mediaBleed()
            .widthIn(min = 200.dp)
            .height(260.dp)
            .clip(RoundedCornerShape(tokens.radiusMedia))
            .background(Color(0xFF101010)),
    ) {
        Box(
            Modifier
                .size(54.dp)
                .align(Alignment.Center)
                .background(Color(0x8C0B0B10), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                VeltaIcons.playFilled,
                contentDescription = null,
                modifier = Modifier.size(26.dp),
                tint = Color(0xFFF2F2F5),
            )
        }
        message.fileBytes?.takeIf { it > 0 }?.let { bytes ->
            MediaChip(formatBytes(bytes), Modifier.align(Alignment.TopStart).padding(8.dp))
        }
        message.duration?.takeIf { it > 0 }?.let { ms ->
            MediaChip(formatDuration(ms), Modifier.align(Alignment.BottomEnd).padding(8.dp))
        }
    }
}

/** Web .msg-audio: the .vp bar once the file is here (play, seek, speed,
 *  "00:03 / 00:04"); before that a card whose tap downloads and plays. */
@Composable
private fun AudioBubble(model: AppModel, message: MessageObject, tokens: VeltaTokens) {
    if (message.id in model.audioFailed) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(vertical = 6.dp)) {
            Icon(VeltaIcons.mic, contentDescription = null, modifier = Modifier.size(22.dp), tint = tokens.textDim)
            Text(L.t("Audio can't be played"), fontSize = 14.sp, color = tokens.textDim)
        }
        return
    }
    val ready = (message.downloadState ?: "Done") == "Done" && message.file != null
    if (!ready || model.audioEngine == null) {
        Box(Modifier.tapOpens { model.toggleAudio(message) }) { AudioCard(message, tokens) }
        return
    }
    val now = model.audioNow?.takeIf { it.msgId == message.id }
    val playing = now?.playing == true
    val totalMs = maxOf(now?.durMs ?: 0L, message.duration ?: 0L)
    val posMs = now?.posMs ?: 0L
    var dragging by remember(message.id) { mutableStateOf<Float?>(null) }
    val label = if (message.viewType == "Voice") L.t("Voice message") else L.t("Audio")
    Row(
        Modifier
            .gestureSkip(model)
            .widthIn(min = 240.dp, max = 320.dp)
            .fillMaxWidth()
            .height(40.dp)
            .background(Color(0x2E000000), RoundedCornerShape(20.dp))
            .padding(start = 4.dp, end = 10.dp)
            .semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier
                .size(32.dp)
                .clip(CircleShape)
                .background(tokens.accent)
                .clickable(role = androidx.compose.ui.semantics.Role.Button, onClickLabel = null) { model.toggleAudio(message) }
                .semantics { contentDescription = if (playing) L.t("Pause") else L.t("Play") },
            contentAlignment = Alignment.Center,
        ) {
            Icon(if (playing) VeltaIcons.pauseFilled else VeltaIcons.playFilled, contentDescription = null, modifier = Modifier.size(20.dp), tint = tokens.onAccent)
        }
        androidx.compose.material3.Slider(
            value = (dragging ?: posMs.toFloat()).coerceIn(0f, totalMs.toFloat().coerceAtLeast(0f)),
            onValueChange = { dragging = it },
            onValueChangeFinished = { dragging?.let { model.seekAudio(message, it.toLong()) }; dragging = null },
            valueRange = 0f..totalMs.toFloat().coerceAtLeast(1f),
            enabled = totalMs > 0,
            colors = androidx.compose.material3.SliderDefaults.colors(
                thumbColor = tokens.accent,
                activeTrackColor = tokens.accent,
                inactiveTrackColor = tokens.textDim.copy(alpha = 0.35f),
            ),
            modifier = Modifier.weight(1f).semantics { contentDescription = L.t("Seek") },
        )
        Box(
            Modifier
                .height(24.dp)
                .widthIn(min = 36.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0x387F7F7F))
                .clickable(role = androidx.compose.ui.semantics.Role.Button) { model.cycleVoiceSpeed() }
                .semantics { contentDescription = L.t("Playback speed") + ": " + speedLabel(model.voiceSpeed) }
                .padding(horizontal = 8.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(speedLabel(model.voiceSpeed), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = tokens.accentText)
        }
        Text(
            audioTimeLabel(dragging?.toLong() ?: posMs, totalMs),
            fontSize = 12.sp,
            color = tokens.text,
            maxLines = 1,
            modifier = Modifier.alpha(0.85f),
        )
    }
}

/** Stable #voice-rec: red dot, "Recording 0:07", Cancel, Send. */
@Composable
private fun VoiceRecBar(model: AppModel, rec: AppModel.VoiceRec) {
    val tokens = Velta.tokens
    var elapsed by remember(rec) { mutableStateOf(0L) }
    LaunchedEffect(rec) {
        while (true) {
            elapsed = ((model.clockMillis() - rec.startedAt) / 1000).coerceAtLeast(0)
            kotlinx.coroutines.delay(500)
        }
    }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(10.dp).background(tokens.danger, CircleShape))
        Spacer(Modifier.size(10.dp))
        Text(
            L.t("Recording {time}").replace("{time}", formatDurationSec(elapsed)),
            fontSize = 14.sp,
            color = tokens.text,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = { model.stopVoice(false) }) { Text(L.t("Cancel"), color = tokens.accentText) }
        TextButton(onClick = { model.stopVoice(true) }) { Text(L.t("Send"), color = tokens.accentText) }
    }
}

/** Web .msg-voice/.msg-audio before download: 42px play circle + name/duration. */
@Composable
private fun AudioCard(message: MessageObject, tokens: VeltaTokens) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.widthIn(min = 220.dp),
    ) {
        Box(
            Modifier.size(42.dp).background(tokens.accent, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                VeltaIcons.playFilled,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
                tint = tokens.onAccent,
            )
        }
        Column {
            Text(
                message.fileName
                    ?: if (message.viewType == "Voice") L.t("Voice message") else L.t("Audio"),
                fontSize = 14.5.sp,
                fontWeight = FontWeight.Medium,
                color = tokens.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val meta = message.duration?.takeIf { it > 0 }?.let { formatDuration(it) } ?: message.viewType
            Text(meta, fontSize = 12.5.sp, color = tokens.textDim)
        }
    }
}

/** Web .msg-file: 44px accent circle icon + name 14.5px/500 + size 12.5px. */
@Composable
private fun FileCard(message: MessageObject, tokens: VeltaTokens) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.widthIn(min = 210.dp),
    ) {
        Box(
            Modifier.size(44.dp).background(tokens.accent, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                viewTypeIcon(message.viewType),
                contentDescription = null,
                modifier = Modifier.size(22.dp),
                tint = tokens.onAccent,
            )
        }
        Column(Modifier.weight(1f, fill = false)) {
            Text(
                message.fileName ?: message.viewType,
                fontSize = 14.5.sp,
                fontWeight = FontWeight.Medium,
                color = tokens.text,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            message.fileBytes?.takeIf { it > 0 }?.let { bytes ->
                Text(formatBytes(bytes), fontSize = 12.5.sp, color = tokens.textDim)
            }
        }
    }
}

/** chat-view.js download card (.msg-file.download-btn): download icon,
 *  name or kind, then "Downloading…" / size / "Tap to download". */
@Composable
private fun DownloadCard(message: MessageObject, tokens: VeltaTokens) {
    AttachmentCardRow(
        icon = VeltaIcons.download,
        name = L.t(downloadCardName(message)),
        sub = L.t(downloadCardSub(message, message.fileBytes?.takeIf { it > 0 }?.let { formatBytes(it) })),
        tokens = tokens,
    )
}

/** chat-view.js `_hiddenCard` (.msg-textonly): shield, name or kind,
 *  "Hidden — Text-only mode" and the only action, Show / Download and show. */
@Composable
private fun HiddenAttachmentCard(model: AppModel, message: MessageObject, tokens: VeltaTokens, actionColor: Color) {
    AttachmentCardRow(
        icon = VeltaIcons.shield,
        name = message.fileName?.takeIf { it.isNotEmpty() } ?: L.t(hiddenKindLabel(message.viewType)),
        sub = L.t("Hidden — Text-only mode"),
        tokens = tokens,
    ) {
        TextButton(onClick = { model.revealAttachment(message) }) {
            Text(L.t(revealActionLabel(message.downloadState)), color = actionColor, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun AttachmentCardRow(
    icon: ImageVector,
    name: String,
    sub: String,
    tokens: VeltaTokens,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.widthIn(min = 210.dp),
    ) {
        Box(
            Modifier.size(44.dp).background(tokens.accent, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp), tint = tokens.onAccent)
        }
        Column(Modifier.weight(1f, fill = false)) {
            Text(name, fontSize = 14.5.sp, fontWeight = FontWeight.Medium, color = tokens.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(sub, fontSize = 12.5.sp, color = tokens.textDim)
        }
        trailing?.invoke()
    }
}

/** "1.5 MB" / "320 KB" — the web's formatBytes (BINARY units). */
private fun formatBytes(bytes: Long): String {
    val kb = bytes / 1024.0
    val mb = kb / 1024.0
    return when {
        mb >= 1 -> "${(mb * 10).roundToInt() / 10.0} MB"
        kb >= 1 -> "${kb.roundToInt()} KB"
        else -> "$bytes B"
    }
}

/** "01:23" — the web's formatDuration chip (wire duration is ms). */
private fun formatDuration(ms: Long): String = formatDurationSec(ms / 1000)

