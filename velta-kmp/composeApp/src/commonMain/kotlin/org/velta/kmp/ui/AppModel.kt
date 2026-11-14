package org.velta.kmp.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.TimeSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.velta.kmp.core.ChatListItem
import org.velta.kmp.core.Contact
import org.velta.kmp.core.CoreEvent
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.MessageObject
import org.velta.kmp.core.RpcClient
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.core.VeltaCore

/**
 * P2 application state: connect, RESUME a persisted account (the core's
 * accounts dir is the storage — no app-level settings), login fallback,
 * read paths with event-driven refresh.
 */
class AppModel(
    private val platform: CorePlatform,
    private val scope: CoroutineScope,
) {
    companion object {
        /** Messages fetched per page in the chat view (#223). */
        const val MESSAGE_PAGE_SIZE = 200

        /** #57 chip bar (web index.html:48-54, in order). */
        val CHAT_CATEGORIES = listOf("all", "unread", "people", "groups", "channels", "bots", "system")
    }

    sealed interface Screen {
        data object Login : Screen
        data object ChatList : Screen
        data object Relays : Screen
        data object Accounts : Screen
        data object Join : Screen
        data object Settings : Screen
        data class Chat(val chatId: Long, val title: String, val isGroup: Boolean) : Screen
        data class Profile(val chatId: Long, val title: String) : Screen
    }

    var screen by mutableStateOf<Screen>(Screen.Login)
    var status by mutableStateOf("starting")
        private set
    var coreVersion by mutableStateOf("?")
        private set
    var connected by mutableStateOf(false)
        private set
    var accountAddr by mutableStateOf<String?>(null)
        private set
    var loginBusy by mutableStateOf(false)
        private set
    var loginProgress by mutableStateOf<String?>(null)
        private set
    var loginError by mutableStateOf<String?>(null)

    var chats by mutableStateOf<List<ChatListItem>>(emptyList())
    var chatsLoading by mutableStateOf(false)
        private set

    // ---- Main-screen side views (#329): the web list-bar renders
    // chats/contacts/calls/qr/new IN PLACE of the chat list; setListView
    // toggles (tapping the active view returns to chats). Search opens from
    // the head button and rides the same mechanism (web listView).
    var listView by mutableStateOf("chats")

    /** #57 category bar — persisted under the web's localStorage key. */
    var chatCategory by mutableStateOf(
        platform.pref("velta-chat-category")?.takeIf { it in CHAT_CATEGORIES } ?: "all",
    )
        private set

    fun onSetChatCategory(cat: String) {
        if (cat !in CHAT_CATEGORIES) return
        chatCategory = cat
        platform.setPref("velta-chat-category", if (cat == "all") null else cat)
    }

    fun toggleListView(view: String) {
        // Web setListView: tapping the active view returns to chats.
        listView = if (listView == view) "chats" else view
        if (listView == "contacts") refreshContacts()
        if (listView == "calls") loadCallLog()
        if (listView == "qr") inviteLink = null // fresh visit re-fetches the code
    }

    /** Chats behind the active chip (web visibleChats). */
    fun chatsFor(category: String): List<ChatListItem> = when (category) {
        "all" -> chats
        "unread" -> chats.filter { chatIsUnread(it) }
        else -> chats.filter { chatCategoryOf(it, ::chatIsBot) == category }
    }

    /** Bots per contact id — one lazy get_contacts on first People/Bots use
     * (web ensureContactBots); a failed fetch keeps the previous flags. */
    var contactBots by mutableStateOf<Map<Long, Boolean>?>(null)
        private set
    var contactBotsError by mutableStateOf<String?>(null)
        private set
    private var contactBotsAcct: Long? = null

    private fun chatIsBot(contactId: Long): Boolean =
        contactBotsAcct == accountId && contactBots?.get(contactId) == true

    fun ensureContactBots() {
        if ((chatCategory == "people" || chatCategory == "bots") &&
            (contactBots == null || contactBotsAcct != accountId)
        ) {
            refreshContacts()
        }
    }

    // ---- Contacts view ----
    var contacts by mutableStateOf<List<Contact>>(emptyList())
        private set
    var contactsLoading by mutableStateOf(false)
        private set

    fun refreshContacts() {
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
        scope.launch {
            contactsLoading = true
            try {
                val list = veltaCore.contacts(id)
                contacts = list
                // The same call carries the bot flags for the category bar.
                contactBots = list.associate { it.id to it.isBot }
                contactBotsAcct = id
                contactBotsError = null
            } catch (t: Throwable) {
                // A failed get_contacts must NOT become "no bots".
                if (contactBots == null || contactBotsAcct != id) contactBotsError = t.message ?: t.toString()
                println("velta-kmp: contacts failed: $t")
            } finally {
                contactsLoading = false
            }
        }
    }

    /** Contacts the user actually has a 1:1 chat with (web knownContactIds). */
    fun knownContactIds(): Set<Long> =
        chats.mapNotNull { if (chatKindOf(it) == "single") it.dmChatContact else null }.toSet()

    /** "Show only known contacts" toggle (web velta-known-contacts-only, default on). */
    var knownContactsOnly by mutableStateOf(platform.pref("velta-known-contacts-only") != "0")

    fun onSetKnownContactsOnly(on: Boolean) {
        knownContactsOnly = on
        platform.setPref("velta-known-contacts-only", if (on) null else "0")
    }

    /** Tap a contact → create/open the 1:1 chat (web contacts view row). */
    fun openContactChat(contact: Contact) {
        val veltaCore = core ?: return
        val id = accountId ?: return
        scope.launch {
            try {
                val chatId = veltaCore.createChatByContactId(id, contact.id)
                loadChats()
                chats.firstOrNull { it.id == chatId }?.let { openChat(it) }
            } catch (t: Throwable) {
                println("velta-kmp: open contact chat failed: $t")
            }
        }
    }

    // ---- Calls view: a LOCAL log (the core stores no call log — web
    // velta-call-log, capped 30), fed by the core's CallEnded event.
    @kotlinx.serialization.Serializable
    data class CallLogEntry(val chatId: Long, val ts: Long)

    var callLog by mutableStateOf<List<CallLogEntry>>(emptyList())
        private set

    private fun loadCallLog() {
        val raw = platform.pref("velta-call-log") ?: run { callLog = emptyList(); return }
        callLog = runCatching {
            kotlinx.serialization.json.Json.decodeFromString(kotlinx.serialization.builtins.ListSerializer(CallLogEntry.serializer()), raw)
        }.getOrDefault(emptyList())
    }

    private fun recordCallEnded(chatId: Long) {
        if (chatId <= 0L) return
        val log = mutableListOf(CallLogEntry(chatId, wallClockSeconds()))
        log.addAll(callLog.filterNot { it.chatId == chatId })
        callLog = log.take(30)
        platform.setPref("velta-call-log", kotlinx.serialization.json.Json.encodeToString(kotlinx.serialization.builtins.ListSerializer(CallLogEntry.serializer()), callLog))
    }

    // ---- QR view ("Your QR code"): the core's self invite; the code text IS
    // the canonical invite link. The SVG is discarded — KMP draws its own
    // card from the QrEncode port + the core card geometry (web reencodes
    // the core SVG; captions/disc ride the account identity below).
    var inviteLink by mutableStateOf<String?>(null)
        private set
    var inviteLoading by mutableStateOf(false)
        private set
    var inviteError by mutableStateOf<String?>(null)

    /** Card center-disc identity: account display name + self contact color. */
    var inviteName by mutableStateOf("")
        private set
    var inviteColor by mutableStateOf<String?>(null)
        private set

    fun loadInviteQr() {
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null || inviteLoading) return
        scope.launch {
            inviteLoading = true
            inviteError = null
            try {
                inviteLink = veltaCore.inviteQr(id).first.ifBlank { null }
                // core self_info: displayname (fallback addr) + self contact color.
                val info = runCatching { veltaCore.accountInfo(id) }.getOrNull()
                inviteName = info?.displayName?.takeIf { it.isNotBlank() }
                    ?: info?.addr?.takeIf { it.isNotBlank() }
                    ?: ""
                if (inviteName.isBlank()) {
                    println("velta-kmp: invite card name empty — accountInfo failed or blank (info=${info != null})")
                }
                if (inviteColor == null) {
                    inviteColor = runCatching { veltaCore.contact(id, 1).color }.getOrNull()
                }
            } catch (t: Throwable) {
                inviteError = t.message ?: t.toString()
            } finally {
                inviteLoading = false
            }
        }
    }

    /** Platform-injected share (Android ACTION_SEND); null = no Share button (web canShareLink). */
    var shareText: ((String) -> Unit)? = null

    // ---- Archived (the search view's tab + the list-end link row). ----
    var archivedChats by mutableStateOf<List<ChatListItem>>(emptyList())
        private set

    fun loadArchivedChats() {
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
        scope.launch {
            try {
                // DC_GCL_ARCHIVED_ONLY = 0x01 (web getChatListIds archived:true).
                val ids = veltaCore.chatlistEntries(id, listFlags = 1)
                archivedChats = veltaCore.chatlistItems(id, ids)
                    .sortedWith(compareByDescending<ChatListItem> { it.isPinned }.thenByDescending { it.lastUpdated ?: 0L })
            } catch (t: Throwable) {
                println("velta-kmp: archived chats failed: $t")
            }
        }
    }

    /** Opens a chat by id (calls/archived rows carry only the chatId). */
    fun openChatById(chatId: Long) {
        (chats.firstOrNull { it.id == chatId } ?: archivedChats.firstOrNull { it.id == chatId })
            ?.let { openChat(it) }
    }

    // ---- "Start something" flows (web newChatOptions): each action first
    // returns to the chats view; the created chat opens once the list lands.

    /** Contact picker request — rendered as a screen (web pickContactModal). */
    data class ContactPickRequest(val titleKey: String, val multi: Boolean)
    var contactPick by mutableStateOf<ContactPickRequest?>(null)
        private set

    /** The flow the open picker belongs to: "chat" (single-pick) or "group" (multi-pick). */
    private var pendingPickFlow: String? = null

    /** Group members awaiting the name dialog (web pick → askGroupName). */
    var pickedMembers by mutableStateOf<List<Contact>>(emptyList())
        private set

    fun startNewChatFlow() {
        pendingPickFlow = "chat"
        contactPick = ContactPickRequest("New chat", multi = false)
    }

    fun startNewGroupFlow() {
        pendingPickFlow = "group"
        contactPick = ContactPickRequest("Add group members", multi = true)
    }

    fun startNewChannelFlow() {
        pendingPickFlow = "channel"
    }

    fun onContactsPicked(picked: List<Contact>) {
        contactPick = null
        when (pendingPickFlow) {
            "chat" -> picked.firstOrNull()?.let { openContactChat(it) }
            "group" -> if (picked.isNotEmpty()) {
                pickedMembers = picked
                showGroupNameDialog = true
            }
        }
        pendingPickFlow = null
    }

    fun cancelContactPick() {
        contactPick = null
        pendingPickFlow = null
    }

    /** Group-name dialog visible (after a multi-pick). */
    var showGroupNameDialog by mutableStateOf(false)

    /** Channel-name dialog visible. */
    var showChannelDialog by mutableStateOf(false)

    fun createGroup(name: String, admin: Boolean) {
        val veltaCore = core ?: return
        val id = accountId ?: return
        val members = pickedMembers
        showGroupNameDialog = false
        pickedMembers = emptyList()
        scope.launch {
            try {
                val chatId = if (admin) veltaCore.createGroupWithAdmin(id, name) else veltaCore.createGroupChat(id, name)
                members.forEach { veltaCore.addContactToChat(id, chatId, it.id) }
                loadChats()
                chats.firstOrNull { it.id == chatId }?.let { openChat(it) }
            } catch (t: Throwable) {
                println("velta-kmp: create group failed: $t")
            }
        }
    }

    fun createChannel(name: String) {
        val veltaCore = core ?: return
        val id = accountId ?: return
        showChannelDialog = false
        scope.launch {
            try {
                val chatId = veltaCore.createBroadcast(id, name)
                loadChats()
                chats.firstOrNull { it.id == chatId }?.let { openChat(it) }
            } catch (t: Throwable) {
                println("velta-kmp: create channel failed: $t")
            }
        }
    }

    /** "Join chat via invite link" / "Add a relay to this account" — both
     * ride the Join screen (paste/scan DCACCOUNT / secure-join). */
    fun openJoinFromNewChat() {
        joinChecked = null
        joinError = null
        screen = Screen.Join
    }

    /** Platform hook (Android): posts a conversation notification. Null on
     * desktop. */
    var notifier: IncomingNotifier? = null

    /** Set from a notification tap; consumed when the chat list lands. */
    var pendingOpenChatId: Long? = null

    /** Peer fingerprint hex per 1:1 chat id (identity matrix tiles); filled
     * asynchronously after the list lands. */
    var identities by mutableStateOf<Map<Long, String>>(emptyMap())
        private set

    // ---- Profile (contact sheet) ----

    data class ProfileData(
        val chatId: Long,
        val contactId: Long?,
        val chatName: String,
        val contactName: String,
        val addr: String,
        val fingerprint: String?,
        val lastSeenSeconds: Long,
        val blocked: Boolean,
        val muted: Boolean,
        val ephemeralSecs: Int,
        val isSingle: Boolean,
        val isSelfTalk: Boolean,
        val isDeviceTalk: Boolean,
        val photos: Int,
        val videos: Int,
        val audio: Int,
        val files: Int,
        val apps: Int,
    )

    var profile by mutableStateOf<ProfileData?>(null)
    var profileLoading by mutableStateOf(false)
        private set

    // ---- Relay management (P4) ----
    var relays by mutableStateOf<List<org.velta.kmp.core.RelayCard>>(emptyList())
    var relaysLoading by mutableStateOf(false)
        private set

    /** One-line reason shown at the top of the Relays screen (e.g. the
     * relay-cap error that routed the user here); cleared on next refresh. */
    var relaysNotice by mutableStateOf<String?>(null)
        private set

    /** Account-wide connectivity (1000 down / 2000 connecting / 4000 connected). Null until the first read. */
    var relayConnectivity by mutableStateOf<Int?>(null)
        private set

    /**
     * Per-relay strip segments with their display state (web renderRelayLine):
     * a parse of get_connectivity_html + the #76 probe downgrade. Empty = no
     * parseable transports (single combined segment colored by
     * [relayConnectivity]).
     */
    data class RelaySegDisplay(
        val domain: String,
        val state: String, // ok | connecting | down | unreachable | offline
        val title: String,
        val isSendRelay: Boolean,
    )

    var relaySegments by mutableStateOf<List<RelaySegDisplay>>(emptyList())
        private set

    /** #79: the transport SMTP is actually bound to (may fail over). */
    private var smtpVia: String? = null

    /** #76 probe cache per domain (web relayProbeCache): ok/ts/failedSince. */
    private data class ProbeEntry(val ok: Boolean?, val ts: Long, val failedSince: Long?)
    private val relayProbes = HashMap<String, ProbeEntry>()

    private var relayLineBusy = false
    private var relayLineArmed = false
    private var relayLineMark = TimeSource.Monotonic.markNow()

    // ---- Account switcher (P4) ----
    var accounts by mutableStateOf<List<org.velta.kmp.core.Account>>(emptyList())
    var accountsLoading by mutableStateOf(false)
        private set
    var chatMessages by mutableStateOf<List<MessageObject>>(emptyList())
    var chatLoading by mutableStateOf(false)
        private set
    var senderNames by mutableStateOf<Map<Long, String>>(emptyMap())
        private set

    /** Chat header (web velta-chat-head): avatar inputs + the status line.
     *  Set synchronously from the ChatListItem on open; memberCount and
     *  lastSeen fill in from the async fullChat/contact fetch. */
    data class ChatHead(
        val kind: String,
        val colorHex: String?,
        val avatarPath: String?,
        val fingerprint: String?,
        val memberCount: Int? = null,
        val lastSeen: Long? = null,
        val isBot: Boolean = false,
    )

    var chatHead by mutableStateOf<ChatHead?>(null)
        private set

    // ---- Composer (P3) ----
    var composerText by mutableStateOf("")
    var replyTo by mutableStateOf<MessageObject?>(null)
    var sending by mutableStateOf(false)
        private set
    var sendError by mutableStateOf<String?>(null)

    /** Message whose action bar (react / reply) is open; null = hidden. */
    var messageActions by mutableStateOf<MessageObject?>(null)

    // ---- App lock (P4, phase 4 port) ----

    /** True while the platform is app-locked: no core, no plaintext, UI blocked. */
    var locked by mutableStateOf(false)
        private set

    /** The app-lock setting (Accounts row reflects it). */
    var appLockOn by mutableStateOf(false)
        private set

    /** Platform-injected: run the biometric/credential prompt; on success hand over. */
    var requestUnlock: (() -> Unit)? = null
    var requestAppLockEnable: (() -> Unit)? = null
    var requestAppLockDisable: (() -> Unit)? = null

    /** (picked path, display name) awaiting send; the core dedups it into its blobdir. */
    var pendingAttachment by mutableStateOf<Pair<String, String>?>(null)

    /** Attachment picker kinds — the web attach menu (chat-view.js). */
    enum class AttachKind { PHOTO, VIDEO, FILE }

    /** Platform-injected file-picker launcher (desktop FileDialog / Android SAF),
     * keyed by the menu kind so Android can pre-filter the SAF mime types. */
    var attachmentPicker: ((AttachKind) -> Unit)? = null

    fun attach(kind: AttachKind) {
        attachmentPicker?.invoke(kind)
    }

    // ---- Invite / join (P4) ----
    var joinText by mutableStateOf("")
    var joinChecked by mutableStateOf<org.velta.kmp.core.CoreQr?>(null)
    var joinBusy by mutableStateOf(false)
        private set
    var joinError by mutableStateOf<String?>(null)

    /** Platform-injected: run the camera scanner; result lands in onQrScanned. */
    var requestQrScan: (() -> Unit)? = null

    /** Platform-injected camera capture (Android ACTION_IMAGE_CAPTURE); the
     * shot lands in onAttachmentPicked. Null = no camera menu item. */
    var cameraCapture: (() -> Unit)? = null

    /** Scanner result → the Join screen, pre-filled and immediately checked. */
    fun onQrScanned(text: String) {
        joinText = text
        joinChecked = null
        joinError = null
        screen = Screen.Join
        checkJoin()
    }

    /** Parse what the user pasted; surface the kind so the UI can explain it. */
    fun checkJoin() {
        val veltaCore = core
        val id = accountId ?: unconfiguredAccountId
        val qr = joinText.trim()
        if (veltaCore == null || qr.isEmpty()) return
        scope.launch {
            joinBusy = true
            joinError = null
            try {
                joinChecked = veltaCore.checkQr(
                    (id ?: veltaCore.addAccount()).also { accountId = it },
                    qr,
                )
            } catch (t: Throwable) {
                joinError = t.message ?: t.toString()
            } finally {
                joinBusy = false
            }
        }
    }

    /**
     * Route on the checked kind: "account" = relay onboarding (transport +
     * configure, mirroring login), "ask*" = secure-join (the chat appears and
     * the protocol runs in the background).
     */
    fun join() {
        val veltaCore = core
        val qr = joinChecked ?: return
        val raw = joinText.trim()
        if (veltaCore == null || raw.isEmpty() || joinBusy) return
        scope.launch {
            joinBusy = true
            joinError = null
            try {
                val id = accountId
                    ?: unconfiguredAccountId
                    ?: veltaCore.addAccount()
                accountId = id
                when {
                    // DCACCOUNT and DCLOGIN both land here. addTransportFromQr
                    // handles both kinds, runs the full configure (probe +
                    // transports-table insert) and restarts I/O itself —
                    // do NOT call the legacy configure(): it loads old-style
                    // addr/mail_pw configs the QR flow never sets and fails
                    // with "missing email address" (core 2.69 multi-transport).
                    qr.isAccountInvite || qr.isLoginInvite -> {
                        // Re-scanning an invite for a relay the account is
                        // ALREADY on must skip: a delete-then-re-add of the
                        // only transport once errored and would leave the
                        // account with zero transports if the add failed.
                        // Stacking duplicates (the old cap-5 bug) is equally
                        // out — one row per domain.
                        val onThisRelay = qr.domain?.let { domain ->
                            veltaCore.relayCards(id).firstOrNull { it.addr.contains(domain) }
                        }
                        if (onThisRelay == null) {
                            veltaCore.addTransportFromQr(id, raw)
                            veltaCore.startIoForAllAccounts()
                        }
                        accountAddr = veltaCore.accountInfo(id).addr
                        loadChats()
                        screen = Screen.ChatList
                        refreshRelayLine()
                    }
                    qr.isSecureJoin -> {
                        veltaCore.startIoForAllAccounts()
                        veltaCore.secureJoin(id, raw)
                        loadChats()
                        screen = Screen.ChatList
                        refreshRelayLine()
                    }
                    else -> joinError = "this QR is not an invite (kind: ${qr.kind})"
                }
            } catch (t: Throwable) {
                val message = t.message ?: t.toString()
                joinError = message
                println("velta-kmp: join error: $message")
                // The relay cap is not a dead end: send the user to the relay
                // manager where a slot can be freed, with the reason attached.
                if (message.contains("maximum number of relays", ignoreCase = true)) {
                    relaysNotice = message
                    openRelays()
                }
            } finally {
                joinBusy = false
            }
        }
    }

    fun closeJoin() {
        joinText = ""
        joinChecked = null
        joinError = null
        screen = if (accountId != null) Screen.ChatList else Screen.Login
    }

    /** Called by the platform after a file was picked and staged readable. */
    fun onAttachmentPicked(path: String, displayName: String?) {
        pendingAttachment = path to (displayName ?: path.substringAfterLast('/'))
    }

    private var core: VeltaCore? = null
    private var transport: RpcTransport? = null
    private var connecting = false

    /** The account the UI is currently rooted at (public read for the switcher). */
    var accountId: Long? = null
        private set

    /** An account that exists but is not configured — reused by the next login attempt. */
    private var unconfiguredAccountId: Long? = null

    /**
     * Start (or reuse) the core connection. Idempotent: the foreground
     * service calls this after a process kill, the UI calls it at launch —
     * one core, one event loop, whichever call wins first.
     *
     * [keyOverride] is the app-lock unlock path: the DEK from the bio wrap
     * after a successful prompt. Without it, an app-locked platform stays
     * locked — no core, no plaintext.
     */
    fun connect(keyOverride: String? = null) {
        if (connected || connecting) return
        if (keyOverride == null && platform.isAppLocked()) {
            locked = true
            status = "locked"
            return
        }
        connecting = true
        scope.launch {
            status = "spawning core"
            val dir = platform.accountsDir()
            val spawned = if (keyOverride != null) {
                platform.spawnRpcServerWithKey(dir, keyOverride)
            } else {
                platform.spawnRpcServer(dir)
            }
            if (spawned == null) {
                status = platform.connectHint()
                connecting = false
                return@launch
            }
            transport = spawned
            val client = RpcClient(
                spawned,
                log = { line -> println("velta-kmp: $line") },
                onDead = { onCoreDead() },
            )
            val veltaCore = VeltaCore(client)
            core = veltaCore

            try {
                status = "handshake"
                val info = veltaCore.systemInfo()
                coreVersion = (info["deltachat_core_version"]?.toString() ?: "?").trim('"')
                connected = true
                locked = false

                veltaCore.startEventLoop(scope) { event ->
                    handleEvent(event)
                }

                resumeSession(veltaCore)
                println("velta-kmp: connect ok — core $coreVersion, ${modelAccountsSummary()}")
            } catch (t: Throwable) {
                status = "connect failed: ${t.message}"
                // Drop the half-built connection so a retry starts clean; on
                // Android the shim itself survives (port cached) and the retry
                // just opens a new socket to it.
                client.close()
                core = null
                transport = null
            } finally {
                connecting = false
            }
        }
    }

    /** The RPC connection died on its own (core gone, socket closed): release
     * the UI so the app degrades visibly, then try one self-heal reconnect. */
    private fun onCoreDead() {
        if (!connected) return
        connected = false
        core = null
        transport = null
        status = "core connection lost"
        println("velta-kmp: core connection lost — reconnecting")
        scope.launch {
            delay(2000)
            connect()
        }
    }

    /** Deliberate teardown (service destroyed): drop the client and stop the
     * platform core. The next connect() starts fresh. */
    fun shutdownCore() {
        core?.raw?.close()
        core = null
        transport = null
        connected = false
        status = "core stopped"
        platform.stopRpcServer()
        println("velta-kmp: core stopped (shutdownCore)")
    }

    private fun modelAccountsSummary(): String =
        when (val id = accountId) {
            null -> "no account resumed"
            else -> "account $id active"
        }

    /**
     * P2 persistence: the core's accounts dir already holds every account.
     * Resume the first configured one straight into the chat list; keep an
     * unconfigured one around so a login retry doesn't create duplicates.
     */
    private suspend fun resumeSession(veltaCore: VeltaCore) {
        status = "looking for accounts"
        val ids = veltaCore.allAccountIds()
        val selectedId = runCatching { veltaCore.selectedAccountId() }.getOrNull()
        var configured: org.velta.kmp.core.Account? = null
        var fallbackConfigured: org.velta.kmp.core.Account? = null
        var unconfigured: Long? = null
        for (id in ids) {
            val info = runCatching { veltaCore.accountInfo(id) }.getOrNull() ?: continue
            if (info.configured) {
                // The core's own selection wins (it persists across restarts);
                // otherwise the first configured account.
                if (configured == null || info.id == selectedId) configured = info
                if (fallbackConfigured == null) fallbackConfigured = info
            } else if (unconfigured == null) {
                unconfigured = id
            }
        }
        if (configured == null) configured = fallbackConfigured
        unconfiguredAccountId = unconfigured
        val account = configured
        if (account != null) {
            accountId = account.id
            accountAddr = account.addr
            // Write the choice back (the fallback may not be the core's
            // selected id) and arm mail. A failure must not hide the local list.
            runCatching { veltaCore.selectAccount(account.id) }
                .onFailure { println("velta-kmp: selectAccount on resume failed: $it") }
            runCatching { veltaCore.startIoForAllAccounts() }
                .onFailure { println("velta-kmp: startIo on resume failed: $it") }
            // Sequential on purpose: the chat list is loaded BEFORE the screen
            // switches, so resume never flashes an empty list.
            loadChats()
            screen = Screen.ChatList
            refreshRelayLine()
            status = "resumed ${account.addr ?: ""}".trim()
        } else {
            status = "connected"
            screen = Screen.Login
        }
    }

    fun login(addr: String, password: String) {
        val veltaCore = core ?: return
        if (loginBusy) return
        scope.launch {
            loginBusy = true
            loginError = null
            loginProgress = null
            try {
                val id = accountId
                    ?: unconfiguredAccountId
                    ?: veltaCore.addAccount()
                accountId = id
                unconfiguredAccountId = null
                veltaCore.addTransport(id, addr.trim(), password)
                status = "configuring"
                veltaCore.configure(id)
                veltaCore.startIoForAllAccounts()
                accountAddr = veltaCore.accountInfo(id).addr
                loadChats()
                screen = Screen.ChatList
                refreshRelayLine()
            } catch (t: Throwable) {
                loginError = t.message ?: t.toString()
            } finally {
                loginBusy = false
                loginProgress = null
                status = if (accountId != null) "configured" else "connected"
            }
        }
    }

    fun refreshChats() {
        scope.launch { loadChats() }
    }

    /** Platform hook contract: one notification per chat, latest text. */
    fun interface IncomingNotifier {
        fun notifyIncoming(chatId: Long, chatName: String, text: String)
    }

    private suspend fun loadChats() {
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
        chatsLoading = true
        try {
            val entries = veltaCore.chatlistEntries(id)
            val items = veltaCore.chatlistItems(id, entries)
            chats = items.sortedWith(
                compareByDescending<ChatListItem> { it.isPinned }
                    .thenByDescending { it.lastUpdated ?: 0L },
            )
            pendingOpenChatId?.let { wanted ->
                chats.firstOrNull { it.id == wanted }?.let { openChat(it) }
                pendingOpenChatId = null
            }
            scope.launch { loadIdentities(id, items) }
            // Archived count for the list-end link row (web getChatListIds archived:true).
            loadArchivedChats()
        } catch (t: Throwable) {
            println("velta-kmp: refreshChats failed: $t")
        } finally {
            chatsLoading = false
        }
    }

    /** Fetches each 1:1 peer's fingerprint for the identity matrix tiles.
     * Sequential is fine: a handful of chats, two small RPCs each. */
    private suspend fun loadIdentities(accountId: Long, items: List<ChatListItem>) {
        val veltaCore = core ?: return
        val map = HashMap<Long, String>()
        for (item in items) {
            if (item.isGroup || item.isSelfTalk || item.isDeviceTalk) continue
            try {
                val cid = veltaCore.chatContactIds(accountId, item.id).firstOrNull() ?: continue
                val info = veltaCore.contactEncryptionInfo(accountId, cid) ?: continue
                val fpr = identityFingerprintFromEncrInfo(info, contactName = item.name) ?: continue
                map[item.id] = fpr
            } catch (t: Throwable) {
                println("velta-kmp: identity for chat ${item.id} failed: $t")
            }
        }
        identities = map
    }

    // ---- Profile (contact sheet) ----

    fun openProfile(chatId: Long, title: String) {
        screen = Screen.Profile(chatId, title)
        profile = null
        scope.launch { loadProfile(chatId) }
    }

    fun backFromProfile() {
        val p = profile
        if (p != null) screen = Screen.Chat(p.chatId, p.chatName, false) else screen = Screen.ChatList
    }

    fun toggleBlockPeer() {
        val p = profile ?: return
        val cid = p.contactId ?: return
        scope.launch {
            val veltaCore = core
            val id = accountId
            if (veltaCore == null || id == null) return@launch
            try {
                veltaCore.setContactBlocked(id, cid, !p.blocked)
            } catch (t: Throwable) {
                println("velta-kmp: block failed: $t")
                return@launch
            }
            loadProfile(p.chatId)
        }
    }

    private suspend fun loadProfile(chatId: Long) {
        val veltaCore = core ?: return
        val id = accountId ?: return
        profileLoading = true
        try {
            val chat = veltaCore.fullChat(id, chatId) ?: return
            fun jstr(o: kotlinx.serialization.json.JsonObject, k: String) =
                (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.content
            fun jbool(o: kotlinx.serialization.json.JsonObject, k: String) =
                (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.content == "true"
            val isSingle = jstr(chat, "chatType") == "Single"
            var contactId: Long? = null
            var addr = ""
            var contactName = ""
            var lastSeen = 0L
            var blocked = false
            var fingerprint: String? = null
            if (isSingle) {
                val cid = (chat["contactIds"] as? kotlinx.serialization.json.JsonArray)
                    ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull() }
                    ?.firstOrNull()
                if (cid != null) {
                    contactId = cid
                    val c = veltaCore.contact(id, cid)
                    if (c != null) {
                        addr = c.address
                        contactName = c.displayName
                        lastSeen = c.lastSeen
                        blocked = c.isBlocked
                    }
                    fingerprint = identityFingerprintFromEncrInfo(
                        veltaCore.contactEncryptionInfo(id, cid) ?: "",
                        contactAddr = addr,
                        contactName = contactName,
                    )
                }
            }
            profile = ProfileData(
                chatId = chatId,
                contactId = contactId,
                chatName = jstr(chat, "name") ?: "",
                contactName = contactName,
                addr = addr,
                fingerprint = fingerprint,
                lastSeenSeconds = lastSeen,
                blocked = blocked,
                muted = jbool(chat, "isMuted"),
                ephemeralSecs = jstr(chat, "ephemeralTimer")?.toIntOrNull() ?: 0,
                isSingle = isSingle,
                isSelfTalk = jbool(chat, "isSelfTalk"),
                isDeviceTalk = jbool(chat, "isDeviceChat"),
                photos = veltaCore.chatMediaIds(id, chatId, "Image", "Gif", null).size,
                videos = veltaCore.chatMediaIds(id, chatId, "Video", null, null).size,
                audio = veltaCore.chatMediaIds(id, chatId, "Audio", "Voice", null).size,
                files = veltaCore.chatMediaIds(id, chatId, "File", null, null).size,
                apps = veltaCore.chatMediaIds(id, chatId, "Webxdc", null, null).size,
            )
        } catch (t: Throwable) {
            println("velta-kmp: profile $chatId failed: $t")
        } finally {
            profileLoading = false
        }
    }

    /** Chat header inputs (web velta-chat-head): the avatar rides the list
     *  item (color/avatar/identity), the status line = member count for
     *  groups/channels, last-seen for 1:1, bot/static lines for the rest.
     *  memberCount/lastSeen land async from fullChat/contact. */
    private fun loadChatHead(item: ChatListItem) {
        val head = ChatHead(
            kind = chatKindOf(item),
            colorHex = item.color,
            avatarPath = item.avatarPath,
            fingerprint = identities[item.id],
            isBot = item.dmChatContact?.let { chatIsBot(it) } == true,
        )
        chatHead = head
        ensureContactBots()
        scope.launch {
            val veltaCore = core ?: return@launch
            val id = accountId ?: return@launch
            runCatching {
                val chat = veltaCore.fullChat(id, item.id) ?: return@launch
                fun jstr(o: kotlinx.serialization.json.JsonObject, k: String) =
                    (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.content
                val ids = (chat["contactIds"] as? kotlinx.serialization.json.JsonArray)
                    ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull() }
                if (jstr(chat, "chatType") == "Single") {
                    val cid = ids?.firstOrNull() ?: return@launch
                    val contact = veltaCore.contact(id, cid)
                    // Web statusLine: the header keeps the row's own bot flag.
                    chatHead = chatHead?.copy(lastSeen = contact.lastSeen)
                } else {
                    chatHead = chatHead?.copy(memberCount = ids?.size ?: 0)
                }
            }
        }
    }

    fun openChat(item: ChatListItem) {
        screen = Screen.Chat(item.id, item.name, item.isGroup)
        composerText = ""
        replyTo = null
        sendError = null
        senderNames = emptyMap()
        pendingAttachment = null
        messageActions = null
        loadChatHead(item)
        scope.launch {
            val veltaCore = core
            val id = accountId
            if (veltaCore != null && id != null) {
                try {
                    veltaCore.marknoticedChat(id, item.id)
                } catch (t: Throwable) {
                    println("velta-kmp: marknoticed failed: $t")
                }
            }
        }
        // Draft restore rides its own coroutine — it must not wait behind
        // marknoticed (which can be slow or, in tests, never answer).
        scope.launch {
            val veltaCore = core
            val id = accountId
            if (veltaCore != null && id != null) {
                veltaCore.draft(id, item.id)?.let { saved ->
                    if (composerText.isBlank()) composerText = saved.text ?: ""
                    val quotedId = saved.quotedMessageId
                    if (quotedId != null && replyTo == null) {
                        replyTo = veltaCore.messages(id, listOf(quotedId)).firstOrNull { it.id == quotedId }
                    }
                }
            }
        }
        loadMessages(item.id)
        loadChatMembers(item.id)
        refreshChats()
    }

    /** Persist or clear the draft of the open chat when leaving it. */
    fun backToChatList() {
        val chat = screen as? Screen.Chat
        val veltaCore = core
        val id = accountId
        if (chat != null && veltaCore != null && id != null) {
            val text = composerText
            val attachment = pendingAttachment
            scope.launch {
                try {
                    if (text.isNotBlank() || attachment != null) {
                        veltaCore.setDraft(
                            id,
                            chat.chatId,
                            text,
                            replyTo?.id,
                            file = attachment?.first,
                            filename = attachment?.second,
                        )
                    } else {
                        veltaCore.removeDraft(id, chat.chatId)
                    }
                } catch (t: Throwable) {
                    println("velta-kmp: draft save failed: $t")
                }
            }
        }
        composerText = ""
        replyTo = null
        sendError = null
        pendingAttachment = null
        screen = Screen.ChatList
        refreshChats()
    }

    // ---- Relays (P4) ----

    fun openRelays() {
        screen = Screen.Relays
        refreshRelays()
    }

    fun backFromRelays() {
        relaysNotice = null
        screen = Screen.ChatList
    }

    /** Chat-list strip. Skips bursts: get_connectivity itself emits ConnectivityChanged. */
    private fun refreshRelayLine() {
        val veltaCore = core ?: return
        val id = accountId ?: return
        scope.launch {
            if (relayLineBusy) return@launch
            if (relayLineArmed && relayLineMark.elapsedNow() < 1500.milliseconds) return@launch
            relayLineBusy = true
            relayLineArmed = true
            relayLineMark = TimeSource.Monotonic.markNow()
            try {
                relayConnectivity = runCatching { veltaCore.connectivity(id) }.getOrNull()
                if (relays.isEmpty()) {
                    relays = runCatching { veltaCore.relayCards(id) }.getOrDefault(emptyList())
                }
                // Per-transport strip (web renderRelayLine): parse the HTML
                // page, then downgrade through the #76 shell-side probe.
                val html = runCatching { veltaCore.connectivityHtml(id) }.getOrDefault("")
                val parse = parseConnectivityHtml(html)
                synchronized(reloadLock) { smtpVia = parse.smtpVia }
                scheduleRelayProbes(parse.segs)
                relaySegments = relayDisplaySegments(parse)
            } finally {
                relayLineBusy = false
            }
        }
    }

    /** Composes the display segments: parse state → probe downgrade → send attribution. */
    private fun relayDisplaySegments(parse: ConnectivityParse): List<RelaySegDisplay> {
        val now = wallClockMillis()
        val sendDomain: String?
        synchronized(reloadLock) { sendDomain = smtpVia }
        val effectiveSend = sendDomain ?: accountAddr?.substringAfterLast("@")?.lowercase()
        return parse.segs.mapIndexed { i, seg ->
            val domainKey = seg.domain.lowercase()
            val probe = synchronized(reloadLock) { relayProbes[domainKey] }
            var state = relaySegmentDisplayState(seg.state, probe?.ok, probe?.failedSince, now)
            var isSend = segsSendRelay(parse.segs.size, seg.domain, effectiveSend)
            val base = if (seg.domain.isNotEmpty()) "${seg.domain}: ${seg.text}" else seg.text.ifEmpty { "Relay" }
            var title = when (state) {
                "unreachable" -> "$base: not accepting new connections (web check failed)"
                "offline" -> "$base: offline (not accepting connections for a while)"
                else -> base
            }
            if (isSend && state != "offline" && relaySeverity(parse.smtpState) > relaySeverity(state)) {
                state = parse.smtpState ?: state // the SMTP dot outranks the segment (web 1321-1323)
                title = "$base — sending"
            }
            if (seg.quota.isNotEmpty()) title = "$title · ${seg.quota}"
            RelaySegDisplay(seg.domain, state, title, isSend)
        }
    }

    /** Web isSendRelay: the SMTP-bound transport; a single relay always counts. */
    private fun segsSendRelay(count: Int, domain: String, sendDomain: String?): Boolean {
        if (sendDomain == null) return count == 1
        if (count == 1) return true
        return domain.lowercase() == sendDomain.lowercase()
    }

    /** #76 probe scheduling (web scheduleRelayProbes): one probe per domain,
     * min 60 s between tries, ground truth for unreachable/offline. */
    private fun scheduleRelayProbes(segs: List<RelaySeg>) {
        val now = wallClockMillis()
        for (seg in segs) {
            val d = seg.domain.lowercase()
            if (d.isEmpty() || !d.contains(".")) continue
            val launch: Boolean
            synchronized(reloadLock) {
                val cached = relayProbes[d]
                if (cached?.ok == null && cached != null) {
                    launch = false // probe in flight
                } else if (cached != null && now - cached.ts < RELAY_PROBE_MIN_GAP_MS) {
                    launch = false
                } else {
                    relayProbes[d] = ProbeEntry(null, now, cached?.failedSince)
                    launch = true
                }
            }
            if (!launch) continue
            scope.launch {
                val ok = runCatching { probeRelayReachable(d) }.getOrDefault(false)
                synchronized(reloadLock) {
                    val prev = relayProbes[d]
                    relayProbes[d] = if (ok) {
                        ProbeEntry(true, wallClockMillis(), null)
                    } else {
                        ProbeEntry(false, wallClockMillis(), prev?.failedSince ?: wallClockMillis())
                    }
                }
                refreshRelayLine()
            }
        }
    }

    /** Millis wall clock for the probe/grace windows (probe constants are ms). */
    private fun wallClockMillis(): Long = wallClockSeconds() * 1000L

    fun refreshRelays() {
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
        scope.launch {
            relaysLoading = true
            try {
                relays = veltaCore.relayCards(id)
            } catch (t: Throwable) {
                println("velta-kmp: refreshRelays failed: $t")
            } finally {
                relaysLoading = false
            }
        }
    }

    fun removeRelay(addr: String) {
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
        scope.launch {
            try {
                veltaCore.deleteTransport(id, addr)
            } catch (t: Throwable) {
                println("velta-kmp: removeRelay failed: $t")
            }
            refreshRelays()
        }
    }

    // ---- Account switcher (P4) ----

    fun openAccounts() {
        screen = Screen.Accounts
        refreshAccounts()
        refreshBattery()
        refreshAppLockState()
    }

    fun backFromAccounts() {
        screen = Screen.ChatList
    }

    fun refreshAccounts() {
        val veltaCore = core
        if (veltaCore == null) return
        scope.launch {
            accountsLoading = true
            try {
                accounts = veltaCore.allAccounts()
            } catch (t: Throwable) {
                println("velta-kmp: refreshAccounts failed: $t")
            } finally {
                accountsLoading = false
            }
        }
    }

    /** Switch to another account: the core remembers the choice across restarts. */
    fun switchAccount(id: Long) {
        val veltaCore = core
        if (veltaCore == null) return
        scope.launch {
            try {
                veltaCore.selectAccount(id)
            } catch (t: Throwable) {
                println("velta-kmp: selectAccount failed: $t")
            }
            accountId = id
            composerText = ""
            replyTo = null
            pendingAttachment = null
            messageActions = null
            sendError = null
            try {
                accountAddr = veltaCore.accountInfo(id).addr
            } catch (t: Throwable) {
                println("velta-kmp: accountInfo failed: $t")
            }
            loadChats()
            screen = Screen.ChatList
        }
    }

    /** "Add account" from the switcher → the login screen (login() reuses/creates). */
    fun addAccountFromSwitcher() {
        screen = Screen.Login
    }

    // ---- Battery allowance (P4) — injected by the Android entry point ----

    /** Platform-injected: fire the system battery-exemption dialog. */
    var requestBatteryExemption: (() -> Unit)? = null

    /** Platform-injected: is the app exempt from battery optimizations? */
    var batteryCheck: (() -> Boolean?)? = null

    /** null = platform cannot report (desktop); true/false = exempt/restricted. */
    var batteryExempt by mutableStateOf<Boolean?>(null)
        private set

    fun refreshBattery() {
        batteryExempt = batteryCheck?.invoke()
    }

    /** System dialog → the user allows or denies; refresh afterwards. */
    fun requestBatteryAllowance() {
        requestBatteryExemption?.invoke()
        scope.launch {
            kotlinx.coroutines.delay(1500)
            refreshBattery()
        }
    }

    // ---- Push (P4, Android) — entered by VeltaPushService ----

    /**
     * A UnifiedPush endpoint arrived: ensure the core is up, then register
     * the token (the shim's `velta_set_push_device_token`; the core encrypts
     * it to the notifier key and registers via IMAP METADATA on next io).
     */
    fun onPushEndpoint(token: String) {
        scope.launch {
            try {
                ensureConnected()
                core?.setPushDeviceToken(token)
                println("velta-kmp: push endpoint registered")
            } catch (t: Throwable) {
                println("velta-kmp: push endpoint registration failed: $t")
            }
        }
    }

    /** A push message arrived: fetch. Results surface through the event loop. */
    fun onPushWakeup() {
        scope.launch {
            try {
                ensureConnected()
                core?.startIoForAllAccounts()
                core?.backgroundFetch(30.0)
                println("velta-kmp: push-triggered fetch done")
            } catch (t: Throwable) {
                println("velta-kmp: push fetch failed: $t")
            }
        }
    }

    fun onPushUnregistered() {
        println("velta-kmp: push unregistered — re-register on next start")
    }

    // ---- App lock (P4, phase 4 port) — the UI side ----

    /** Unlock button pressed: the platform runs the prompt, then hands the DEK. */
    fun onAppUnlocked(dekHex: String) {
        locked = false
        connect(dekHex)
    }

    /** The user opted in on the Accounts screen (prompt already succeeded). */
    fun onAppLockEnabled() {
        appLockOn = platform.enableAppLock()
        if (!appLockOn) {
            // Roll forward on the next unlock — nothing user-visible broke.
            println("velta-kmp: app lock enable failed")
        }
    }

    fun onAppLockDisabled() {
        appLockOn = platform.disableAppLock()
    }

    fun refreshAppLockState() {
        appLockOn = platform.isAppLockOn()
        if (!appLockOn) locked = false
    }

    /** connect() + wait for the handshake; for non-UI entry points. */
    private suspend fun ensureConnected() {
        if (!connected) {
            connect()
            kotlinx.coroutines.withTimeout(30_000) {
                while (!connected) kotlinx.coroutines.delay(200)
            }
        }
    }

    /**
     * P3 send: `misc_set_draft` (text + optional quote) then `misc_send_draft`.
     * After the send returns, the message exists in the db with real
     * OutPending state — reload immediately so the bubble shows with ⏳
     * instead of waiting for the event echo.
     */
    fun send() {
        val chat = screen as? Screen.Chat ?: return
        val veltaCore = core
        val id = accountId
        val text = composerText.trim()
        val attachment = pendingAttachment
        if (veltaCore == null || id == null || sending) return
        if (text.isEmpty() && attachment == null) return
        val quote = replyTo?.id
        composerText = ""
        replyTo = null
        sendError = null
        sending = true
        scope.launch {
            try {
                veltaCore.setDraft(
                    id,
                    chat.chatId,
                    text,
                    quote,
                    file = attachment?.first,
                    filename = attachment?.second,
                )
                veltaCore.sendDraft(id, chat.chatId)
                pendingAttachment = null
                loadMessages(chat.chatId, chat.isGroup)
            } catch (t: Throwable) {
                sendError = t.message ?: t.toString()
                // Restore what the user composed so nothing is lost.
                if (composerText.isBlank()) composerText = text
                if (pendingAttachment == null) pendingAttachment = attachment
            } finally {
                sending = false
            }
        }
    }

    // ---- Message actions: reactions + reply (P3) ----

    fun toggleMessageActions(message: MessageObject) {
        messageActions = if (messageActions?.id == message.id) null else message
    }

    fun react(message: MessageObject, emoji: String) {
        val veltaCore = core
        val id = accountId
        messageActions = null
        if (veltaCore == null || id == null) return
        scope.launch {
            try {
                veltaCore.sendReaction(id, message.id, listOf(emoji))
                if (screen is Screen.Chat) loadMessages((screen as Screen.Chat).chatId, (screen as Screen.Chat).isGroup)
            } catch (t: Throwable) {
                println("velta-kmp: react failed: $t")
            }
        }
    }

    fun startReply(message: MessageObject) {
        replyTo = message
        messageActions = null
    }

    // ---- Mentions: member list per chat (names + fingerprint codes) ----
    var chatMembers by mutableStateOf<Map<Long, List<MentionMember>>>(emptyMap())
        private set

    /** Jump-to-message request (quote tap); consumed by the chat screen. */
    var pendingJumpToId by mutableStateOf<Long?>(null)

    /** Sticker packs for the composer picker (pack name → file paths). */
    var stickerPacks by mutableStateOf<Map<String, List<String>>>(emptyMap())
        private set

    /** An invite link tapped inside a bubble — routed to the Join flow. */
    fun openInviteLink(url: String) {
        // invites.js: mirror links are normalized onto the canonical
        // i.delta.chat form BEFORE check/secure-join — the core only parses
        // that scheme.
        joinText = parseInviteLink(url) ?: url
        joinChecked = null
        joinError = null
        screen = Screen.Join
        checkJoin()
    }

    /** Quote tap: jump when the quoted message is in the loaded window. */
    fun jumpToQuoted(messageId: Long?) {
        if (messageId != null && chatMessages.any { it.id == messageId }) {
            pendingJumpToId = messageId
        }
    }

    // ---- Appearance + language (#321 step 5). The web keeps these in
    // localStorage (dw-theme / velta-amoled / velta-accent / velta-lang);
    // KMP stores the SAME keys via the platform prefs seam. AMOLED is a
    // flag layered on dark (app.js applyTheme), never its own theme value.
    var themeChoice by mutableStateOf(
        when (platform.pref("dw-theme")) {
            "dark" -> VeltaThemeChoice.Dark
            "light" -> VeltaThemeChoice.Light
            "brutal" -> VeltaThemeChoice.Brutal
            else -> VeltaThemeChoice.Auto
        },
    )
        private set
    var amoled by mutableStateOf(platform.pref("velta-amoled") == "1")
        private set
    var accentHex by mutableStateOf(Accent.normHex(platform.pref("velta-accent")))
        private set
    var lang by mutableStateOf(platform.pref("velta-lang")?.takeIf { it in L.LANGS.map { it.first } } ?: "en")
        private set

    init {
        // The web applies the stored language before first paint (i18n.js);
        // the model construction is the KMP equivalent hook.
        L.lang = lang
    }

    fun onSetTheme(c: VeltaThemeChoice) {
        themeChoice = c
        platform.setPref("dw-theme", c.name.lowercase())
    }

    fun onSetAmoled(on: Boolean) {
        amoled = on
        platform.setPref("velta-amoled", if (on) "1" else null)
    }

    /** Web write(): null (stock accent) removes the key. */
    fun onSetAccent(hex: String?) {
        accentHex = Accent.normHex(hex)
        platform.setPref("velta-accent", accentHex)
    }

    /** Web setLang: "en" is stored by REMOVING the key (i18n.js:30). */
    fun onSetLang(l: String) {
        if (l !in L.LANGS.map { it.first }) return
        lang = l
        L.lang = l
        platform.setPref("velta-lang", if (l == "en") null else l)
    }

    fun openSettings() {
        screen = Screen.Settings
    }

    fun backFromSettings() {
        screen = Screen.ChatList
    }

    private fun loadChatMembers(chatId: Long) {
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
        scope.launch {
            try {
                val members = veltaCore.chatContactIds(id, chatId).mapNotNull { cid ->
                    val c = runCatching { veltaCore.contact(id, cid) }.getOrNull() ?: return@mapNotNull null
                    val name = c.displayName.ifBlank { c.name }.ifBlank { return@mapNotNull null }
                    val fpr = runCatching {
                        identityFingerprintFromEncrInfo(veltaCore.contactEncryptionInfo(id, cid) ?: "")
                    }.getOrNull()
                    MentionMember(cid, name, fpr?.take(4)?.uppercase() ?: "")
                }
                chatMembers = chatMembers + (chatId to members)
            } catch (t: Throwable) {
                println("velta-kmp: chat members for $chatId failed: $t")
            }
        }
    }

    /** Sticker packs, fetched once per session on first composer open. */
    fun loadStickers() {
        if (stickerPacks.isNotEmpty()) return
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
        scope.launch {
            try {
                stickerPacks = veltaCore.getStickers(id)
            } catch (t: Throwable) {
                println("velta-kmp: stickers failed: $t")
            }
        }
    }

    fun sendSticker(path: String) {
        val veltaCore = core
        val id = accountId
        val chat = screen as? Screen.Chat ?: return
        if (veltaCore == null || id == null) return
        scope.launch {
            try {
                veltaCore.sendSticker(id, chat.chatId, path)
                loadMessages(chat.chatId, chat.isGroup)
            } catch (t: Throwable) {
                sendError = t.message ?: t.toString()
            }
        }
    }

    // ---- Chat paging (#223) ----
    // Load the LAST messagePageSize messages on open; scrolling near the top
    // fetches the page before the loaded window (loadOlderMessages). A reload
    // preserves an older window the user already pulled in.
    private var loadedForChatId: Long? = null
    private var loadedFromIdx = 0
    private var loadingOlder = false
    var hasMoreMessages by mutableStateOf(false)
        private set

    /** Rows the last loadOlderMessages PREPENDED — the chat screen uses it to
     * keep the viewport anchored; reset by the UI once consumed. */
    var pendingPrependCount by mutableStateOf(0)

    private fun loadMessages(chatId: Long, isGroup: Boolean = false) {
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
        scope.launch {
            chatLoading = true
            try {
                val ids = veltaCore.messageIds(id, chatId).sorted()
                // Preserve history the user already pulled in for THIS chat;
                // fresh opens get the newest window.
                val from = if (loadedForChatId == chatId && loadedFromIdx in 1..ids.size) {
                    loadedFromIdx
                } else {
                    (ids.size - MESSAGE_PAGE_SIZE).coerceAtLeast(0)
                }
                loadedForChatId = chatId
                loadedFromIdx = from
                val messages = veltaCore.messages(id, ids.drop(from))
                chatMessages = messages.sortedBy { it.sortTimestamp ?: it.timestamp }
                hasMoreMessages = from > 0
                if (isGroup) loadSenderNames(veltaCore, id, messages)
            } catch (t: Throwable) {
                println("velta-kmp: loadMessages failed: $t")
            } finally {
                chatLoading = false
            }
        }
    }

    /** Fetches the page BEFORE the loaded window and prepends it. Called by
     * the chat screen when the user scrolls near the older end. */
    fun loadOlderMessages() {
        val current = screen as? Screen.Chat ?: return
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null || !hasMoreMessages || loadingOlder || chatLoading) return
        loadingOlder = true
        scope.launch {
            try {
                val ids = veltaCore.messageIds(id, current.chatId).sorted()
                val listChanged = ids.size <= loadedFromIdx
                if (listChanged || (screen as? Screen.Chat)?.chatId != current.chatId) return@launch
                val from = (loadedFromIdx - MESSAGE_PAGE_SIZE).coerceAtLeast(0)
                val older = veltaCore.messages(id, ids.subList(from, loadedFromIdx))
                pendingPrependCount = older.size
                chatMessages = (older + chatMessages).sortedBy { it.sortTimestamp ?: it.timestamp }
                loadedFromIdx = from
                hasMoreMessages = from > 0
                if (current.isGroup) loadSenderNames(veltaCore, id, older)
            } catch (t: Throwable) {
                println("velta-kmp: loadOlderMessages failed: $t")
            } finally {
                loadingOlder = false
            }
        }
    }

    private suspend fun loadSenderNames(veltaCore: VeltaCore, accountId: Long, messages: List<MessageObject>) {
        // MERGE into the known map: the paging prepend passes only the older
        // page, and a replace would drop every sender already resolved.
        val names = senderNames.toMutableMap()
        for (fromId in messages.map { it.fromId }.distinct()) {
            if (fromId <= 1L) continue // 0/1: special (self/system)
            val contact: Contact? = runCatching { veltaCore.contact(accountId, fromId) }.getOrNull()
            val name = contact?.displayName?.ifBlank { contact.name }?.ifBlank { null } ?: continue
            names[fromId] = name
        }
        senderNames = names
    }

    // ---- Reload coalescing ----
    // Message events arrive in bursts (sync fetches several messages at once);
    // reloading the full list / chat per event is the #294 shape. Mark dirty
    // instead and flush once, 200 ms after the last burst started.
    private val reloadLock = Any()
    private val dirtyChatIds = HashSet<Long>()
    private var dirtyAllChats = false
    private var reloadJob: Job? = null

    private fun scheduleChatReload(chatId: Long?) {
        synchronized(reloadLock) {
            if (chatId == null) dirtyAllChats = true else dirtyChatIds += chatId
            if (reloadJob == null) {
                reloadJob = scope.launch { flushReloads() }
            }
        }
    }

    private suspend fun flushReloads() {
        delay(200)
        val (ids, all) = synchronized(reloadLock) {
            val snapshot = dirtyChatIds.toSet()
            dirtyChatIds.clear()
            val allChats = dirtyAllChats
            dirtyAllChats = false
            reloadJob = null
            snapshot to allChats
        }
        when (val current = screen) {
            is Screen.Chat -> if (all || current.chatId in ids) {
                loadMessages(current.chatId, current.isGroup)
            }
            Screen.ChatList -> if (all || ids.isNotEmpty()) loadChats()
            else -> {}
        }
    }

    private suspend fun handleEvent(event: CoreEvent) {
        when (event.kind) {
            "ConnectivityChanged" -> refreshRelayLine()
            "ConfigureProgress" -> {
                val comment = event.event?.get("comment")?.toString()?.trim('"')
                if (!comment.isNullOrBlank()) loginProgress = comment
            }
            "MsgsChanged", "IncomingMsg", "MsgsNoticed", "MsgDelivered" -> {
                val chatId = event.chatId()
                scheduleChatReload(chatId)
                if (event.kind == "IncomingMsg" && chatId != null) {
                    notifyIncoming(chatId, event)
                }
            }
            "CallEnded" -> event.chatId()?.let { recordCallEnded(it) }
        }
    }

    /** Conversation notification for an incoming message — skipped while the
     * user is looking at that chat, and for muted chats. */
    private suspend fun notifyIncoming(chatId: Long, event: CoreEvent) {
        val current = screen
        if (current is Screen.Chat && current.chatId == chatId) return
        val item = chats.firstOrNull { it.id == chatId }
        if (item?.isMuted == true) return
        val veltaCore = core ?: return
        val id = accountId ?: return
        val msgId = event.event?.get("msgId")?.toString()?.trim('"')?.toLongOrNull()
            ?: event.event?.get("msg_id")?.toString()?.trim('"')?.toLongOrNull()
        val text = msgId?.let { mid -> veltaCore.messages(id, listOf(mid)).firstOrNull()?.text } ?: ""
        notifier?.notifyIncoming(chatId, item?.name ?: "New message", text.ifBlank { "New message" })
    }

    private fun CoreEvent.chatId(): Long? =
        (event?.get("chatId")?.toString())?.trim('"')?.toLongOrNull()
            ?: (event?.get("chat_id")?.toString())?.trim('"')?.toLongOrNull()
}
