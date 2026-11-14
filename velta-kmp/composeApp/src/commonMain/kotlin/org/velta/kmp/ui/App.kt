package org.velta.kmp.ui

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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
            } else {
                when (val current = model.screen) {
                    AppModel.Screen.Login -> JoinScreen(model, welcome = true)
                    AppModel.Screen.ChatList -> ChatListScreen(model)
                    AppModel.Screen.Relays -> RelaysScreen(model)
                    AppModel.Screen.Settings -> SettingsScreen(model)
                    AppModel.Screen.Accounts -> AccountsScreen(model)
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
    // The contact picker takes over the screen (web pickContactModal).
    if (model.contactPick != null) {
        PickContactsScreen(model)
        return
    }
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
    PlatformBackHandler(enabled = model.listView != "chats") {
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
    Column(Modifier.fillMaxSize()) {
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
            val listState = rememberLazyListState()
            LazyColumn(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .pointerInput(Unit) {
                        // Web pull-open: pulling down at the very top reveals
                        // the relay detail chips.
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                            // Only a pull from the absolute top counts (web
                            // touchstart gate: scrollTop <= 0).
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
                    },
            ) {
                items(shown, key = { it.id }) { item ->
                    ChatListRow(item, model.identities[item.id]) { model.openChat(item) }
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
                            InviteQrCard(model)
                            Text(
                                model.inviteLink.orEmpty(),
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
                                TextButton(onClick = { clipboard.setText(AnnotatedString(model.inviteLink.orEmpty())) }) {
                                    Icon(VeltaIcons.copy, contentDescription = null, modifier = Modifier.size(18.dp))
                                    Spacer(Modifier.size(6.dp))
                                    Text(L.t("Copy a link"))
                                }
                                if (model.shareText != null) {
                                    TextButton(onClick = { model.shareText?.invoke(model.inviteLink.orEmpty()) }) {
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
private fun ContactLikeChatRow(item: ChatListItem, subSize: TextUnit, onClick: () -> Unit) {
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
        val shown = if (model.knownContactsOnly) model.contacts.filter { it.id in known } else model.contacts
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
                    TextButton(onClick = onDismiss) { Text(L.t("Cancel")) }
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
                    TextButton(onClick = onDismiss) { Text(L.t("Cancel")) }
                    Button(onClick = onConfirm, enabled = confirmEnabled) { Text(confirmLabel) }
                }
            }
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
    val segments = model.relaySegments
    Box(Modifier.fillMaxWidth().height(26.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(6.dp)
                .align(Alignment.Center)
                .clickable { model.openRelays() }
                .semantics { contentDescription = "Relay status" },
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

/** Web maskRelayDomain (app.js:1266): "d13*.dev" — first 3 chars, a star,
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
                        text = { Text("Invite") },
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
 * The core's invite CARD (qr_code_generator.rs inner_generate_secure_join_qr_code,
 * 515×630) drawn in Compose: #f2f2f2 rounded card with a #c6c6c6 border, the
 * optimally-encoded QR matrix at (57.5,255) scaled 400/size, the bold caption
 * (web/core stock string "Scan to chat with {name}", wrapped 32 chars, 27px
 * or 19px), the center identity disc (ring #f2f2f2 r56.2, disc r47.2 in the
 * self contact's color + white letter) and the footer mark (the core inlines
 * a DC wordmark image KMP doesn't ship — the Velta logo mark stands in).
 * The web mounts this exact card and only re-encodes the module path.
 */
@Composable
private fun InviteQrCard(model: AppModel) {
    val qr = remember(model.inviteLink) {
        runCatching { QrEncode.encode(model.inviteLink!!) }.getOrNull()
    }
    val density = LocalDensity.current
    var boxPx by remember { mutableIntStateOf(0) }
    val wDp = with(density) { boxPx.toDp() }
    val u = wDp.value / 630f // dp per card unit — the square box letterboxes the card by height
    val caption = captionLines(
        // Core stock string (SetupContactQRDescription fallback, stock_str.rs:197) —
        // owned by the core, not a web locale key. Name chain: displayname →
        // account addr → the link's a= param (the link demonstrably carries it).
        "Scan to chat with ${model.inviteName.ifBlank {
            model.accountAddr ?: linkAddr(model.inviteLink) ?: ""
        }}",
    )
    val captionFs = if (caption.size <= 2) 27f else 19f
    val captionShift = if (caption.size <= 2) 0f else -10f
    val letter = model.inviteName.trim().firstOrNull()?.uppercase()
        ?: linkAddr(model.inviteLink)?.firstOrNull()?.uppercaseChar()?.toString()
        ?: "#"
    val discColor = model.inviteColor?.takeIf { it.startsWith("#") }
        ?.let { runCatching { Accent.toColor(it) }.getOrNull() }
        ?: prismTileColor(model.inviteName.ifBlank { model.accountAddr ?: linkAddr(model.inviteLink) ?: "?" })

    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .onSizeChanged { boxPx = it.width },
        contentAlignment = Alignment.TopCenter,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val s = size.width / 630f // px per card unit
            val cardLeft = (size.width - 515f * s) / 2f
            fun cx(x: Float) = cardLeft + x * s
            fun cy(y: Float) = y * s
            // Card: rect x2 y2 511x626 rx40, fill #f2f2f2, stroke #c6c6c6 w2.
            drawRoundRect(
                Color(0xFFF2F2F2),
                topLeft = Offset(cx(2f), cy(2f)),
                size = androidx.compose.ui.geometry.Size(cx(511f), cy(626f)),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(cx(40f)),
            )
            drawRoundRect(
                Color(0xFFC6C6C6),
                topLeft = Offset(cx(2f), cy(2f)),
                size = androidx.compose.ui.geometry.Size(cx(511f), cy(626f)),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(cx(40f)),
                style = Stroke(width = cx(2f)),
            )
            // QR group: translate(57.5, 75), scale 400/size (core L203-208).
            if (qr != null) {
                val cell = 400f * s / qr.size // SIZE only — cx() includes cardLeft!
                val qx = cx(57.5f)
                val qy = cy(75f)
                for (y in 0 until qr.size) for (x in 0 until qr.size) {
                    if (qr[x, y]) {
                        drawRect(
                            Color.Black,
                            topLeft = Offset(qx + x * cell, qy + y * cell),
                            size = androidx.compose.ui.geometry.Size(cell, cell),
                        )
                    }
                }
            }
            // Identity disc centered on the QR (core L289-303: center (257.5, 275)).
            drawCircle(Color(0xFFF2F2F2), radius = cx(56.2f), center = Offset(cx(257.5f), cy(275f)))
            drawCircle(discColor, radius = cx(47.2f), center = Offset(cx(257.5f), cy(275f)))
        }
        // Caption block (bold, black, centered; first baseline y=515+shift).
        Text(
            caption.joinToString("\n"),
            color = Color.Black,
            fontWeight = FontWeight.Bold,
            fontSize = (captionFs * u).sp,
            lineHeight = (captionFs * 1.2f * u).sp,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .offset(y = ((515f + captionShift - captionFs * 1.05f) * u).dp),
        )
        // The white letter on the disc (dominant-baseline central + 6.136 shift →
        // glyph center at y 278.936, weight 400 per the core).
        Text(
            letter,
            color = Color.White,
            fontWeight = FontWeight.Normal,
            fontSize = (61.36f * u).sp,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .offset(y = ((278.936f - 61.36f * 0.55f) * u).dp),
        )
        // Footer mark: the core inlines a 198×35 DC wordmark KMP doesn't
        // ship — the Velta mark at the same slot (height 35).
        Image(
            painterResource(Res.drawable.v_logo),
            contentDescription = null,
            modifier = Modifier
                .offset(y = ((567f - captionShift) * u).dp)
                .height((35f * u).dp),
            contentScale = ContentScale.Fit,
        )
    }
}

/** Core textwrap (qr_code_generator.rs L250-257): word-wrap at 38 chars when
 * the description is longer than 76, else 32. */
private fun captionLines(text: String): List<String> {
    val width = if (text.length > 76) 38 else 32
    val lines = mutableListOf<String>()
    for (word in text.split(" ")) {
        val last = lines.lastOrNull()
        if (last == null) lines.add(word)
        else if (last.length + 1 + word.length <= width) lines[lines.size - 1] = "$last $word"
        else lines.add(word)
    }
    return lines
}

/** The `a=` address param of an i.delta.chat invite link (after the #fragment). */
private fun linkAddr(link: String?): String? =
    link?.let { Regex("[?&]a=([^&]+)").find(it)?.groupValues?.get(1)?.replace("%40", "@") }

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
            if (photoBitmap != null) {
                // Web avatar.js: a single contact's photo sits ON the matrix —
                // inset 19.17%, 2.5% padding, #1c1c1c ring, radius 24.3% (main.css:1754).
                Box(
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
            }
        } else if (photoBitmap != null) {
            Image(
                photoBitmap,
                contentDescription = null,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
            )
        } else {
            Text(prismInitials(name), fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun ChatListRow(item: ChatListItem, identityFpr: String?, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Row(
        modifier = Modifier
            .rowSurface(interaction)
            .fillMaxWidth()
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
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
    // Web back-swipe (chat-view.js:5460-5540): dragging the history leftward
    // slides the pane with the finger; past min(72dp, 28% width) it commits
    // to the chat list. The .18s slide animations are skipped in Compose —
    // commit switches the screen, cancel snaps home.
    val haptics = LocalHapticFeedback.current
    var backDx by remember { mutableStateOf(0f) }
    var listWidthPx by remember { mutableStateOf(0) }
    val lens = model.replyTo == null && model.pendingAttachment == null && model.messageActions == null
    GlassHost(
        Modifier.fillMaxSize().windowInsetsPadding(
            WindowInsets.ime.union(WindowInsets.navigationBars),
        ),
        content = {
        val rows = chatRows(model.chatMessages)
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .onSizeChanged { listWidthPx = it.width }
                .graphicsLayer { translationX = backDx }
                .pointerInput(Unit) {
                    if (!touchGesturesEnabled) return@pointerInput
                    val engage = 12.dp.toPx()
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                        val x0 = down.position.x
                        val y0 = down.position.y
                        var engaged = false
                        var dx = 0f
                        var haptic = false
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Initial)
                            val cur = event.changes.firstOrNull()?.position
                            if (event.changes.none { it.pressed } || cur == null) {
                                if (engaged) {
                                    // Commit: dragged past min(72dp, 28% width).
                                    if (dx <= -Math.min(72.dp.toPx(), listWidthPx * 0.28f)) {
                                        model.backToChatList()
                                    }
                                    backDx = 0f
                                }
                                break
                            }
                            val dxc = cur.x - x0
                            val dyc = cur.y - y0
                            if (!engaged) {
                                if (Math.abs(dyc) > engage && Math.abs(dyc) >= Math.abs(dxc)) break
                                if (dxc > -engage || Math.abs(dxc) < Math.abs(dyc)) continue
                                engaged = true
                            }
                            dx = dxc.coerceIn(-(listWidthPx.toFloat()), 0f)
                            backDx = dx
                            if (dx <= -Math.min(72.dp.toPx(), listWidthPx * 0.28f)) {
                                if (!haptic) {
                                    haptic = true
                                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                }
                            } else {
                                haptic = false
                            }
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
                    // Web .service-msg: system/info messages are mono pills,
                    // not bubbles.
                    is ChatRow.Message if row.message.isInfo -> ServiceMessage(row.message)
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
    val tokens = Velta.tokens
    // Web .day-chip: 13px on #1c1c22 (dark) / #f4f4f4 (light), 14px radius,
    // 12px above / 6px below (the 4dp list gap adds the rest).
    Box(
        Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            fontSize = 13.sp,
            color = if (tokens.isDark) Color(0xFFD7D7DE) else Color(0xFF5D636E),
            modifier = Modifier
                .shadow(if (tokens.isDark) 0.dp else 2.dp, RoundedCornerShape(14.dp))
                .background(
                    if (tokens.isDark) Color(0xFF1C1C22) else Color(0xFFF4F4F4),
                    RoundedCornerShape(14.dp),
                )
                .padding(horizontal = 12.dp, vertical = 4.dp),
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
                    "No sticker packs installed",
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
    val tokens = Velta.tokens
    // .bubble CSS: radius 14px, the tail corner drops to 6px on the sender
    // side; padding 7px 10px 6px; 1px shadow; tokens bgBubbleIn/Out. Stickers
    // strip the fill entirely (.bubble.sticker: transparent, no shadow, no
    // padding, image capped at 175px).
    val sticker = message.viewType == "Sticker" && message.file != null
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
    // engages at 12dp, follows the finger up to 64dp, ticks at the 48dp
    // commit line, and a release past the line opens the reply draft.
    val haptics = LocalHapticFeedback.current
    var replyDx by remember(message.id) { mutableStateOf(0f) }
    val quoteName = if (outgoing) tokens.quoteNameOut else tokens.quoteName
    val quoteBg = tokens.bgReply
    // Web .msg-meta: 11.5px in --text-meta-in/--text-meta-out; ticks read
    // --ticks-read, failures --danger, everything else rides the meta color.
    val metaColor = if (outgoing) tokens.textMetaOut else tokens.textMetaIn
    // Web .bubble max-width: min(480px, 90%). The 42px group avatar rides
    // bottom-aligned on the same 90% row (calc(90% - 50px) effectively).
    Row(
        modifier = Modifier.fillMaxWidth(0.9f),
        horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start,
        verticalAlignment = if (!outgoing && senderName != null) Alignment.Bottom else Alignment.Top,
    ) {
        if (!outgoing && senderName != null) {
            MessageAvatar(senderName)
            Spacer(Modifier.size(8.dp))
        }
        Column(horizontalAlignment = if (outgoing) Alignment.End else Alignment.Start) {
            Surface(
                color = when {
                    sticker -> Color.Transparent
                    outgoing -> tokens.bgBubbleOut
                    else -> tokens.bgBubbleIn
                },
                shape = bubbleShape,
                shadowElevation = if (sticker) 0.dp else 1.dp,
                modifier = Modifier
                    .widthIn(max = 480.dp)
                    .heightIn(min = 20.dp)
                    .graphicsLayer { translationX = replyDx }
                    .clickable(onClick = onTap)
                    .pointerInput(message.id) {
                        if (!touchGesturesEnabled) return@pointerInput
                        val engage = 12.dp.toPx()
                        val commit = 48.dp.toPx()
                        val clamp = 64.dp.toPx()
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false)
                            val x0 = down.position.x
                            val y0 = down.position.y
                            var engaged = false
                            var dx = 0f
                            var haptic = false
                            while (true) {
                                val event = awaitPointerEvent()
                                val cur = event.changes.firstOrNull()?.position
                                if (event.changes.none { it.pressed } || cur == null) {
                                    // Release: past the commit line opens the
                                    // reply draft (web endReplySwipe(true));
                                    // either way the bubble springs home.
                                    if (engaged && dx >= commit) model.startReply(message)
                                    replyDx = 0f
                                    break
                                }
                                val dxc = cur.x - x0
                                val dyc = cur.y - y0
                                if (!engaged) {
                                    if (Math.abs(dyc) > engage && Math.abs(dyc) >= Math.abs(dxc)) break
                                    if (dxc < engage || Math.abs(dxc) < Math.abs(dyc)) continue
                                    engaged = true
                                }
                                dx = dxc.coerceIn(0f, clamp)
                                replyDx = dx
                                if (dx >= commit) {
                                    if (!haptic) {
                                        haptic = true
                                        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    }
                                } else {
                                    haptic = false
                                }
                                event.changes.forEach { it.consume() }
                            }
                        }
                    },
            ) {
                Column(
                    Modifier.padding(
                        if (sticker) PaddingValues(0.dp)
                        else PaddingValues(start = 10.dp, end = 10.dp, top = 7.dp, bottom = 6.dp),
                    ),
                ) {
                    if (!outgoing && senderName != null) {
                        // Web .msg-sender: 13.5px, semibold, person color —
                        // lives INSIDE the bubble (stickers included; the
                        // transparent bubble lets it float).
                        Text(
                            senderName,
                            fontSize = 13.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = prismSenderColor(senderName, tokens.bgBubbleIn),
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
                    val mediaShown = message.viewType in MEDIA_VIEWTYPES && message.file != null
                    if (mediaShown) {
                        MediaFromDisk(
                            message.file!!,
                            message.dimensionsWidth,
                            message.dimensionsHeight,
                            sticker = message.viewType == "Sticker",
                            modifier = if (message.viewType == "Sticker") Modifier else Modifier.mediaBleed(),
                        )
                    } else when (message.viewType) {
                        // Web .msg-video: #101010 band with a play button and
                        // size/duration chips. No playback engine yet (P4).
                        "Video" -> VideoCard(message, tokens)
                        // Web .msg-voice/.msg-audio: play circle + meta. Static.
                        "Audio", "Voice" -> AudioCard(message, tokens)
                        // Web .msg-file: 44px accent circle + name + size.
                        "File", "Webxdc" -> FileCard(message, tokens)
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
                                    modifier = Modifier
                                        .background(tokens.bgReply, RoundedCornerShape(12.dp))
                                        .border(
                                            1.dp,
                                            if (chip.mine) tokens.accent else tokens.border,
                                            RoundedCornerShape(12.dp),
                                        )
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

/** Web <velta-avatar size="42">: Prism tile, 22% radius, initials. */
@Composable
private fun MessageAvatar(name: String) {
    Box(
        Modifier
            .size(42.dp)
            .clip(RoundedCornerShape(9.dp))
            .background(prismTileColor(name)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            prismInitials(name),
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            color = Color(0xFFF4F4F4),
        )
    }
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

/** Web .msg-voice/.msg-audio: 42px play circle + name/duration. Static card. */
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

/** "1:23" — the web's m:ss duration chip (wire duration is ms). */
private fun formatDuration(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0)
    return "${total / 60}:${(total % 60).toString().padStart(2, '0')}"
}

private data class ReactionChip(val emoji: String, val count: Int, val mine: Boolean)

/** Aggregate the core's `Reactions` object (`contactsByReaction`: emoji →
 *  contact list); `mine` flags rows where SELF (contact id 1) reacted. */
private fun reactionChips(reactions: kotlinx.serialization.json.JsonElement?): List<ReactionChip> {
    val byReaction = (reactions as? kotlinx.serialization.json.JsonObject)
        ?.get("contactsByReaction") as? kotlinx.serialization.json.JsonObject
        ?: return emptyList()
    return byReaction.map { (emoji, contacts) ->
        val list = contacts as? kotlinx.serialization.json.JsonArray
        ReactionChip(
            emoji,
            list?.size ?: 0,
            list?.any { (it as? kotlinx.serialization.json.JsonPrimitive)?.content == "1" } == true,
        )
    }
}
