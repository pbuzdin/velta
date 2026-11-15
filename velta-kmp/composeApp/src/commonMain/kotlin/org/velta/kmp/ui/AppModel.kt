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
        /** Unique per account + chat (#334): the Android notification tag. */
        fun notificationKey(accountId: Long, chatId: Long): String = "velta:$accountId:$chatId"

        /** Incoming states the core still counts as unread
         * (core message.rs: 10 InFresh, 13 InNoticed; 16 = InSeen). */
        fun isUnseenIncoming(m: MessageObject): Boolean =
            m.fromId > 1L && !m.isInfo && (m.state == 10 || m.state == 13)

        /** Messages fetched per page in the chat view (#223). */
        const val MESSAGE_PAGE_SIZE = 200

        /** #57 chip bar (web index.html:48-54, in order). */
        val CHAT_CATEGORIES = listOf("all", "unread", "people", "groups", "channels", "bots", "system")

        /** Invite-link domains (web BUILTIN_HOSTS, invites.js:15 — velta.cc
         * default-first; mirrors AndroidManifest intent filters). */
        val INVITE_HOSTS = listOf("velta.cc", "i.delta.chat", "i.deltachat.id", "i.gluek.info")
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
    /** App version for the splash version line (platform-reported). */
    val appVersion: String get() = platform.appVersion()
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

    /** Selected invite-link domain (web chosenDomain, key `velta-invite-domain`;
     * "velta.cc" stores by REMOVING the key like every web default). */
    var inviteDomain by mutableStateOf(platform.pref("velta-invite-domain")?.takeIf { it in INVITE_HOSTS } ?: "velta.cc")
        private set

    fun onSetInviteDomain(domain: String) {
        if (domain !in INVITE_HOSTS) return
        inviteDomain = domain
        platform.setPref("velta-invite-domain", if (domain == "velta.cc") null else domain)
    }

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

    /** A notification tap: which account + chat to open once the core and
     * the chat list are up (#334). */
    data class PendingOpen(val accountId: Long?, val chatId: Long)

    private var pendingOpen: PendingOpen? = null

    /** True while an activity is visible (Android onStart/onStop; desktop
     * stays true). Notifications are suppressed ONLY for the chat on screen
     * while this is true, and read receipts only go out while it is true. */
    var appInForeground by mutableStateOf(true)
        private set

    /** Message ids already sent to markseen_msgs in this session. */
    private val seenSent = HashSet<Long>()

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

    // ---- App lock (P4, phase 4 port) ----

    /** True while the platform is app-locked: no core, no plaintext, UI blocked. */
    var locked by mutableStateOf(false)
        private set

    /** The app-lock setting (Accounts row reflects it). */
    var appLockOn by mutableStateOf(false)
        private set

    /** Last app-lock failure, shown on the lock screen and the lock row
     * (#334: failures used to go to println only). */
    var lockError by mutableStateOf<String?>(null)

    /** Stable's "Lock when hidden" (web key velta-autolock-mins; 0 = off). */
    var autoLockMins by mutableStateOf(
        platform.pref("velta-autolock-mins")?.toIntOrNull()?.takeIf { it in LockPolicy.AUTOLOCK_CHOICES } ?: 0,
    )
        private set

    /** Wall clock for the auto-lock (wall time: the monotonic clock stops
     * in deep sleep, exactly when the phone sits in a pocket). */
    internal var clockMillis: () -> Long = { wallClockSeconds() * 1000L }

    private var hiddenAtMillis: Long? = null

    fun onSetAutoLock(mins: Int) {
        if (mins !in LockPolicy.AUTOLOCK_CHOICES) return
        autoLockMins = mins
        platform.setPref("velta-autolock-mins", if (mins == 0) null else mins.toString())
    }

    /** The platform prompt or keystore step failed; null clears. */
    fun onLockError(message: String?) {
        lockError = message
    }

    /**
     * Lock now (auto-lock): save the open chat's draft, stop the core —
     * the databases close and the DEK leaves memory with it — and show the
     * lock screen. Unlock runs the normal keyed connect.
     */
    fun lockNow() {
        if (locked || !platform.isAppLockOn()) return
        locked = true
        status = "locked"
        val chat = screen as? Screen.Chat
        val veltaCore = core
        val id = accountId
        val text = composerText
        val quote = replyTo?.id
        val attachment = pendingAttachment
        scope.launch {
            if (chat != null && veltaCore != null && id != null && (text.isNotBlank() || attachment != null)) {
                runCatching {
                    veltaCore.setDraft(id, chat.chatId, text, quote, file = attachment?.first, filename = attachment?.second)
                }
            }
            shutdownCore()
            // No plaintext left on screen state behind the lock.
            chats = emptyList()
            chatMessages = emptyList()
            archivedChats = emptyList()
            composerText = ""
            replyTo = null
            pendingAttachment = null
            resetChatActions()
            profile = null
            screen = Screen.ChatList
            locked = true
            status = "locked"
        }
    }

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

    /** A scan / deep link that arrived before the core was up (cold start). */
    private var pendingScan: String? = null

    /** Scanner result or deep link. On the welcome splash it feeds stable's
     * create / second-device paths; otherwise the Join screen, pre-filled
     * and immediately checked. */
    fun onQrScanned(raw: String) {
        // #334 step 7: velta.cc/join/? and mirror invite links (manifest VIEW
        // filters, shares) are normalized onto the canonical i.delta.chat
        // form first — the core only parses that (invites.js).
        val text = parseInviteLink(raw) ?: raw
        if (core == null || !connected) {
            pendingScan = text
            return
        }
        if (screen == Screen.Login) {
            welcomeFromCode(text)
            return
        }
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
                    else -> joinError = L.t("That QR code isn't a Velta or Delta Chat invite")
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
        if (!connected || locked) return // locked = deliberate stop
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
            consumePendingOpen()
        } else {
            status = "connected"
            screen = Screen.Login
        }
        pendingScan?.let { text ->
            pendingScan = null
            onQrScanned(text)
        }
    }

    // ---- Welcome splash (#334: port of stable's showSplash) ----

    enum class WelcomeMode { Actions, Create, SecondDevice }

    var welcomeMode by mutableStateOf(WelcomeMode.Actions)
    var relayInput by mutableStateOf("")
    var backupInput by mutableStateOf("")
    var nicknameInput by mutableStateOf("")

    /** The step list (ul.ob-steps). */
    var obSteps by mutableStateOf<List<ObStep>>(emptyList())
        private set
    var obBusy by mutableStateOf(false)
        private set

    /** Which create trigger ran last ("ok" / "auto") — it reads "Creating…"
     * while busy and "Retry" after a failure, like stable's button. */
    var obTrigger by mutableStateOf<String?>(null)
        private set
    var obFailed by mutableStateOf(false)
        private set

    /** Stable's toast lines on the splash (bad input, picker errors). */
    var welcomeNotice by mutableStateOf<String?>(null)

    /** Issue #6 nickname ask after the account exists (skippable). */
    var askNickname by mutableStateOf(false)
        private set

    /** One-shot line for the chat list ("Account created on {host}"). */
    var createdNotice by mutableStateOf<String?>(null)

    /** Splash "App log — errors & debug" (onboarding lines and errors). */
    var appLog by mutableStateOf<List<String>>(emptyList())
        private set

    /** Platform-injected backup-file picker (Android SAF); null hides
     * "Restore from a backup…". The staged path lands in [onBackupPicked]. */
    var backupPicker: (() -> Unit)? = null

    /** Test seam: the invite claim's HTTPS GET. */
    internal var httpGet: suspend (String) -> Pair<Int, String> = { httpGetText(it) }

    private var obPhases: List<Pair<Int, String>> = emptyList()
    private var obPhaseIdx = 0
    private var imexKind: String? = null // "receive" | "restore" while a transfer runs
    private var afterNickname: (suspend (VeltaCore, Long) -> Unit)? = null

    /** Claimed invite credentials, parked so a configure failure retries
     * without burning the single-use invite (stable: 30 min, session only). */
    private var parkedClaim: Triple<Onboarding.RelayInvite, Onboarding.Creds, Long>? = null

    fun log(line: String) {
        val stamp = formatTimestamp(wallClockSeconds())
        appLog = (appLog + "$stamp $line").takeLast(200)
        println("velta-kmp: $line")
    }

    private fun addStep(text: String) {
        obSteps = obSteps.map { if (it.state == ObStep.State.Active) it.copy(state = ObStep.State.Done) else it } +
            ObStep(text, ObStep.State.Active)
        log(text)
    }

    private fun finishSteps(ok: Boolean) {
        val to = if (ok) ObStep.State.Done else ObStep.State.Failed
        obSteps = obSteps.map { if (it.state == ObStep.State.Active) it.copy(state = to) else it }
    }

    private fun failStep(text: String) {
        finishSteps(false)
        obSteps = obSteps + ObStep(text, ObStep.State.Failed)
        log(text)
    }

    fun welcomeShowCreate() {
        welcomeMode = WelcomeMode.Create
        welcomeNotice = null
    }

    fun welcomeShowSecondDevice() {
        welcomeMode = WelcomeMode.SecondDevice
        welcomeNotice = null
    }

    fun welcomeShowActions() {
        if (obBusy) return
        welcomeMode = WelcomeMode.Actions
        welcomeNotice = null
        obSteps = emptyList()
        obTrigger = null
        obFailed = false
    }

    /** Scanned / deep-linked code on the splash: a DCBACKUP code is a second
     * device, anything else goes through the create form (stable: the scan
     * fills the relay field and presses Create account). */
    private fun welcomeFromCode(text: String) {
        if (Onboarding.isBackupCode(text)) {
            welcomeMode = WelcomeMode.SecondDevice
            backupInput = text.trim()
            welcomeReceive()
        } else {
            welcomeMode = WelcomeMode.Create
            relayInput = text.trim()
            welcomeSubmit()
        }
    }

    private suspend fun welcomeAccount(veltaCore: VeltaCore): Long {
        val id = accountId ?: unconfiguredAccountId ?: veltaCore.addAccount()
        accountId = id
        unconfiguredAccountId = null
        return id
    }

    /** rpc-core _prepareFirstConfigure: claim the suppressed device labels. */
    private suspend fun prepareFirstConfigure(veltaCore: VeltaCore, id: Long) {
        runCatching {
            if (veltaCore.isConfigured(id)) return
            for (label in Onboarding.SUPPRESSED_DEVICE_LABELS) veltaCore.suppressDeviceMessage(id, label)
        }.onFailure { log("device label prep failed: $it") }
    }

    /**
     * Stable runCreate: intro step, ConfigureProgress phase lines, success →
     * nickname ask → chat list; failure → failed step + Retry.
     */
    private fun runCreate(
        trigger: String,
        intro: String,
        phases: List<Pair<Int, String>>,
        then: (suspend (VeltaCore, Long) -> Unit)? = null,
        run: suspend (VeltaCore, Long) -> Unit,
    ) {
        val veltaCore = core ?: return
        if (obBusy) return
        obBusy = true
        obTrigger = trigger
        obFailed = false
        welcomeNotice = null
        obSteps = emptyList()
        addStep(intro)
        obPhases = phases
        obPhaseIdx = 0
        scope.launch {
            try {
                val id = welcomeAccount(veltaCore)
                prepareFirstConfigure(veltaCore, id)
                run(veltaCore, id)
                runCatching { veltaCore.startIoForAllAccounts() }
                accountAddr = veltaCore.accountInfo(id).addr
                obPhases = emptyList()
                addStep(L.t("Account created — welcome!"))
                finishSteps(true)
                afterNickname = then
                nicknameInput = ""
                askNickname = true
            } catch (t: Throwable) {
                obPhases = emptyList()
                failStep(L.t("Setup failed: ") + (t.message ?: t.toString()))
                obFailed = true
            } finally {
                obBusy = false
            }
        }
    }

    internal fun onConfigureProgress(p: Int) {
        while (obPhaseIdx < obPhases.size && p >= obPhases[obPhaseIdx].first) {
            addStep(obPhases[obPhaseIdx].second)
            obPhaseIdx++
        }
    }

    internal fun onImexProgress(p: Int) {
        val kind = imexKind ?: return
        if (p !in 1..999) return
        val n = (p + 5) / 10
        val text = if (kind == "receive") L.t("Receiving profile… {n}%").replace("{n}", n.toString())
        else L.t("Restoring profile… {n}%").replace("{n}", n.toString())
        // One live percentage line instead of one line per event.
        val last = obSteps.lastOrNull()
        obSteps = if (last != null && last.state == ObStep.State.Active && last.text.endsWith("%")) {
            obSteps.dropLast(1) + last.copy(text = text)
        } else {
            obSteps.map { if (it.state == ObStep.State.Active) it.copy(state = ObStep.State.Done) else it } +
                ObStep(text, ObStep.State.Active)
        }
    }

    /** "Create account" on the form: relay invite link, relay address /
     * dcaccount: link, DCLOGIN code, or a contact/group invite (the core
     * picks a relay near the inviter: init_transports(qr) adds the
     * inviter's relays to its candidates; the join runs after the name). */
    fun welcomeSubmit() {
        if (obBusy) return
        val raw = relayInput.trim()
        val invite = Onboarding.parseRelayInvite(raw)
        if (invite != null) {
            runCreate(
                trigger = "ok",
                intro = L.t("Claiming your invite on {host}").replace("{host}", invite.host),
                phases = Onboarding.phasesForInvite(invite.host),
            ) { veltaCore, id ->
                val creds = claimInvite(invite)
                veltaCore.addTransport(id, creds.email, creds.password)
                parkedClaim = null
            }
            return
        }
        val secureJoin = raw.startsWith("openpgp4fpr:", ignoreCase = true) ||
            Regex("^https://(i\\.delta\\.chat|i\\.deltachat\\.id|i\\.gluek\\.info)/", RegexOption.IGNORE_CASE).containsMatchIn(raw)
        if (secureJoin) {
            runCreate(
                trigger = "ok",
                intro = L.t("Looking for a fast relay…"),
                phases = Onboarding.phasesForAutopick(),
                then = { veltaCore, id -> runCatching { veltaCore.secureJoin(id, raw) }.onFailure { log("secure-join after setup failed: $it") } },
            ) { veltaCore, id -> veltaCore.initTransports(id, raw) }
            return
        }
        val link = Onboarding.normalizeRelayLink(raw)
            ?: raw.takeIf { it.startsWith("dclogin:", ignoreCase = true) }
        if (link == null) {
            welcomeNotice = if (raw.isEmpty()) L.t("Enter a relay address")
            else L.t("That doesn't look like a relay or invite address")
            return
        }
        val host = if (link.startsWith("dclogin:", ignoreCase = true)) {
            link.substringAfter('@').substringBefore('?').substringBefore('/')
        } else {
            Onboarding.hostOfLink(link)
        }
        runCreate(
            trigger = "ok",
            intro = L.t("Attempting to connect to relay at {host}").replace("{host}", host),
            phases = Onboarding.phasesForRelay(host),
        ) { veltaCore, id -> veltaCore.addTransportFromQr(id, link) }
    }

    /** "Autopick the fastest relay": the core probes its public relay pool. */
    fun welcomeAutopick() {
        runCreate(
            trigger = "auto",
            intro = L.t("Looking for a fast relay…"),
            phases = Onboarding.phasesForAutopick(),
        ) { veltaCore, id -> veltaCore.initTransports(id, null) }
    }

    private suspend fun claimInvite(invite: Onboarding.RelayInvite): Onboarding.Creds {
        parkedClaim?.let { (inv, creds, exp) ->
            if (inv == invite && exp > wallClockSeconds()) return creds
        }
        val (status, body) = try {
            httpGet("https://${invite.host}/i/claim?t=${invite.token}")
        } catch (t: Throwable) {
            throw IllegalStateException("Couldn't reach ${invite.host}: ${t.message ?: t}")
        }
        val obj = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(body) as? kotlinx.serialization.json.JsonObject }.getOrNull()
        fun field(k: String) = (obj?.get(k) as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
        val creds = Onboarding.relayClaimResult(status, field("email"), field("password"))
        parkedClaim = Triple(invite, creds, wallClockSeconds() + 30 * 60)
        return creds
    }

    /** Nickname sheet: Save name (true) or Skip (false) → into the app. */
    fun finishNickname(apply: Boolean) {
        val veltaCore = core
        val id = accountId
        askNickname = false
        scope.launch {
            if (apply && veltaCore != null && id != null) {
                val name = nicknameInput.trim()
                if (name.isNotEmpty()) runCatching { veltaCore.setConfig(id, "displayname", name) }
            }
            val then = afterNickname
            afterNickname = null
            if (then != null && veltaCore != null && id != null) then(veltaCore, id)
            val host = accountAddr?.substringAfter('@', "")?.ifBlank { null } ?: L.t("your new relay")
            createdNotice = L.t("Account created on {host}").replace("{host}", host)
            welcomeDone()
        }
    }

    private suspend fun welcomeDone() {
        welcomeMode = WelcomeMode.Actions
        obSteps = emptyList()
        obTrigger = null
        relayInput = ""
        backupInput = ""
        loadChats()
        screen = Screen.ChatList
        refreshRelayLine()
    }

    /** "Add as a second device…": receive a profile from a DCBACKUP code. */
    fun welcomeReceive() {
        val veltaCore = core ?: return
        if (obBusy) return
        val code = backupInput.trim()
        if (!Onboarding.isBackupCode(code)) {
            welcomeNotice = L.t("That doesn't look like a second-device code")
            return
        }
        obBusy = true
        obFailed = false
        welcomeNotice = null
        obSteps = emptyList()
        addStep(L.t("Preparing this device…"))
        imexKind = "receive"
        scope.launch {
            try {
                val id = welcomeAccount(veltaCore)
                veltaCore.getBackup(id, code)
                runCatching { veltaCore.startIoForAllAccounts() }
                finishSteps(true)
                addStep(L.t("Profile received — signing in"))
                finishSteps(true)
                accountAddr = veltaCore.accountInfo(id).addr
                welcomeDone()
            } catch (t: Throwable) {
                failStep(L.t("Transfer failed: ") + (t.message ?: t.toString()))
                obFailed = true
            } finally {
                imexKind = null
                obBusy = false
            }
        }
    }

    fun welcomeRestore() {
        backupPicker?.invoke()
    }

    /** Platform: the picked backup, staged at a readable path (gzip already
     * unpacked), or the read error. */
    fun onBackupPicked(path: String?, error: String? = null) {
        if (error != null) {
            welcomeNotice = L.t("Couldn't read the backup file: ") + error
            return
        }
        val veltaCore = core ?: return
        if (path == null || obBusy) return
        obBusy = true
        obFailed = false
        welcomeNotice = null
        obSteps = emptyList()
        addStep(L.t("Restoring profile…"))
        imexKind = "restore"
        scope.launch {
            try {
                val id = welcomeAccount(veltaCore)
                veltaCore.importBackup(id, path)
                runCatching { veltaCore.startIoForAllAccounts() }
                finishSteps(true)
                addStep(L.t("Profile restored — restarting"))
                finishSteps(true)
                accountAddr = veltaCore.accountInfo(id).addr
                welcomeDone()
            } catch (t: Throwable) {
                log("restore: ${t.message ?: t}")
                failStep(L.t("Restore failed: couldn't import the backup"))
                obFailed = true
            } finally {
                imexKind = null
                obBusy = false
            }
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

    /** Platform hook contract: one notification per (account, chat), latest
     * text; keyed by [notificationKey] so chats of different accounts never
     * replace each other. */
    interface IncomingNotifier {
        fun notifyIncoming(accountId: Long, chatId: Long, chatName: String, text: String)
        fun cancel(accountId: Long, chatId: Long)
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
        if (this.accountId == accountId) identities = map // not a late write after a switch
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
                sheetChat = SheetChat(
                    readOnly = jstr(chat, "canSend") == "false",
                    groupAdminId = jstr(chat, "groupAdminId")?.toLongOrNull(),
                    isGroup = jstr(chat, "chatType") == "Group",
                    isSaved = jstr(chat, "isSelfTalk") == "true",
                    isEncrypted = jstr(chat, "isEncrypted") != "false",
                )
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
        // #334 step 6 (app.js openChat "deaddrop"): a contact request asks
        // first; Accept unblocks it, toasts, and opens the now-normal chat.
        if (item.isContactRequest) {
            chatConfirm = PendingConfirm(contactRequestConfirm(item.name)) { acceptContactRequest(item) }
            return
        }
        screen = Screen.Chat(item.id, item.name, item.isGroup)
        accountId?.let { notifier?.cancel(it, item.id) }
        composerText = ""
        replyTo = null
        sendError = null
        senderNames = emptyMap()
        pendingAttachment = null
        resetChatActions()
        sheetChat = SheetChat(isGroup = item.chatType == "Group" || item.isGroup, isSaved = item.isSelfTalk, isEncrypted = item.isEncrypted)
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
        saveOpenDraft()
        composerText = ""
        replyTo = null
        sendError = null
        pendingAttachment = null
        resetChatActions()
        screen = Screen.ChatList
        refreshChats()
    }

    /** Leaving a chat (back or account switch) keeps its draft like stable
     *  chat-view (text or quote kept, else dropped). Everything is read
     *  NOW — the caller clears the composer right after (#334 bug 11). */
    private fun saveOpenDraft() {
        val chat = screen as? Screen.Chat ?: return
        val veltaCore = core ?: return
        val id = accountId ?: return
        if (editingMsg != null) return
        val text = composerText
        val attachment = pendingAttachment
        val quoteId = replyTo?.id
        scope.launch {
            try {
                if (keepDraft(text, attachment != null, quoteId)) {
                    veltaCore.setDraft(id, chat.chatId, text, quoteId, file = attachment?.first, filename = attachment?.second)
                } else {
                    veltaCore.removeDraft(id, chat.chatId)
                }
            } catch (t: Throwable) {
                println("velta-kmp: draft save failed: $t")
            }
        }
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
            val base = if (seg.domain.isNotEmpty()) "${seg.domain}: ${seg.text}" else seg.text.ifEmpty { L.t("Relay") }
            var title = when (state) {
                "unreachable" -> L.t("{relay}: not accepting new connections (web check failed)").replace("{relay}", base)
                "offline" -> L.t("{relay}: offline (not accepting connections for a while)").replace("{relay}", base)
                else -> base
            }
            if (isSend && state != "offline" && relaySeverity(parse.smtpState) > relaySeverity(state)) {
                state = parse.smtpState ?: state // the SMTP dot outranks the segment (web 1321-1323)
                title = "$base " + L.t("· sending")
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
    internal fun wallClockMillis(): Long = wallClockSeconds() * 1000L

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

    /** app.js relay row [data-remove]: confirm, then delete_transport;
     *  "Relay removed" or the core's error as a toast (#334 bug 15). */
    fun removeRelay(addr: String) {
        if (core == null || accountId == null) return
        chatConfirm = PendingConfirm(relayRemoveConfirm(addr)) { removeRelayNow(addr) }
    }

    private fun removeRelayNow(addr: String) {
        val veltaCore = core ?: return
        val id = accountId ?: return
        scope.launch {
            try {
                veltaCore.deleteTransport(id, addr)
                if (accountId == id) showToast(L.t("Relay removed"))
            } catch (t: Throwable) {
                if (accountId == id) showToast(t.message ?: t.toString(), 4000)
            }
            if (accountId == id) refreshRelays()
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
        scope.launch { switchAccountNow(veltaCore, id) }
    }

    private suspend fun switchAccountNow(veltaCore: VeltaCore, id: Long) {
        saveOpenDraft() // stable keeps the open chat's draft per account
        // Message ids are per-account databases: forget what was marked.
        synchronized(seenSent) { seenSent.clear() }
        try {
            veltaCore.selectAccount(id)
        } catch (t: Throwable) {
            println("velta-kmp: selectAccount failed: $t")
        }
        accountId = id
        composerText = ""
        replyTo = null
        pendingAttachment = null
        resetChatActions()
        sendError = null
        resetAccountCaches()
        try {
            accountAddr = veltaCore.accountInfo(id).addr
        } catch (t: Throwable) {
            println("velta-kmp: accountInfo failed: $t")
        }
        loadChats()
        screen = Screen.ChatList
    }

    /** Everything keyed by chat/contact/message id or fetched once per
     *  profile belongs to the old account (#334 bug 16, app.js
     *  "account-changing"): drop it so the new profile refetches. The call
     *  log stays device-wide like stable's velta-call-log. */
    private fun resetAccountCaches() {
        chats = emptyList()
        archivedChats = emptyList()
        contacts = emptyList()
        contactBots = null
        contactBotsError = null
        identities = emptyMap()
        chatMembers = emptyMap()
        senderNames = emptyMap()
        stickerPacks = emptyMap()
        profile = null
        inviteLink = null
        inviteError = null
        inviteName = ""
        inviteColor = null
        relays = emptyList()
        relaysNotice = null
        relayConnectivity = null
        relaySegments = emptyList()
        chatMessages = emptyList()
        chatHead = null
        loadedForChatId = null
        hasMoreMessages = false
        pendingPrependCount = 0
        pendingJumpToId = null
        synchronized(reloadLock) {
            dirtyChatIds.clear()
            dirtyAllChats = false
            dirtyList = false
            dirtyHead = false
            smtpVia = null
        }
        listView = "chats" // side views hold the old profile's rows
        relayLineArmed = false // the new profile's strip loads now, not throttled
        refreshRelayLine()
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
        lockError = null
        connect(dekHex)
    }

    /** The user opted in on the Accounts screen (prompt already succeeded). */
    fun onAppLockEnabled() {
        appLockOn = platform.enableAppLock()
        lockError = if (appLockOn) null else L.t("Couldn't turn on the app lock")
    }

    fun onAppLockDisabled() {
        val ok = platform.disableAppLock()
        appLockOn = platform.isAppLockOn()
        lockError = if (ok) null else L.t("Couldn't turn off the app lock")
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
        editingMsg?.let { editing ->
            if (text.isNotEmpty()) sendEdit(editing, text)
            return
        }
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
                unarchiveAfterSend(veltaCore, id, chat.chatId)
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

    // ---- Message sheet (#334 step 5): stable's phone message sheet ----

    /** The long-pressed message + the link under the finger (stable
     *  `_msgContextMenu(item, x, y, linkHref)`); null = sheet closed. */
    data class SheetTarget(val message: MessageObject, val linkHref: String = "")

    var messageSheet by mutableStateOf<SheetTarget?>(null)

    /** Chat-level sheet inputs (canSend / admin / encryption), from fullChat. */
    var sheetChat by mutableStateOf(SheetChat())
        private set

    /** Selection mode (stable this.selection): message ids, in tap order. */
    var selection by mutableStateOf<List<Long>>(emptyList())
        private set

    /** Composer edit mode (stable editingMsg). */
    var editingMsg by mutableStateOf<MessageObject?>(null)
        private set

    /** Forward picker open for these ids (stable forwardFlow). */
    var forwardIds by mutableStateOf<List<Long>?>(null)

    /** Message info modal (stable _showInfo). */
    data class MessageInfoData(val message: MessageObject, val rfc724Mid: String? = null, val serverUrls: List<String>? = null)
    var messageInfo by mutableStateOf<MessageInfoData?>(null)

    /** Select text panel (stable _selectMessageText). */
    var selectTextFor by mutableStateOf<MessageObject?>(null)

    /** Selection-bar Delete: the modal confirm (stable confirmDeleteMessagesModal). */
    var deleteConfirmIds by mutableStateOf<List<Long>?>(null)

    /** Short status line (stable toast / errToast). */
    var toast by mutableStateOf<String?>(null)
        private set
    private var toastJob: Job? = null

    fun showToast(text: String, ms: Long = 2500) {
        toast = text
        toastJob?.cancel()
        toastJob = scope.launch {
            delay(ms)
            toast = null
        }
    }

    /** Platform save (Android: Downloads via MediaStore / save dialog):
     *  returns null on success, else the error text. */
    var saveFile: (suspend (path: String, name: String, mime: String?) -> String?)? = null

    // Delete hold (stable _holdDelete): the bubble turns into a tombstone
    // with Undo; the core delete runs when the 10 s window ends.
    data class DeleteHold(val key: Int, val forAll: Boolean, val startedAt: Long, val ms: Long, val committing: Boolean = false)
    var deleteHolds by mutableStateOf<Map<Long, DeleteHold>>(emptyMap())
        private set
    /** Committed deletes keep a compact "Message deleted" row this session. */
    var tombstones by mutableStateOf<Set<Long>>(emptySet())
        private set
    private var deleteSeq = 0
    private val deleteJobs = HashMap<Int, Job>()
    private val deleteBatchIds = HashMap<Int, Pair<Long, List<Long>>>() // key -> (chatId, ids)

    private fun msgById(id: Long): MessageObject? = chatMessages.firstOrNull { it.id == id }

    private fun currentChatId(): Long? = (screen as? Screen.Chat)?.chatId

    private fun reloadOpenChat() {
        val chat = screen as? Screen.Chat ?: return
        loadMessages(chat.chatId, chat.isGroup)
    }

    /** Long-press (stable `_msgContextMenu`): info rows and committed
     *  tombstones get nothing; select-text mode keeps the sheet shut. */
    fun openMessageSheet(message: MessageObject, linkHref: String = "") {
        if (message.isInfo || message.id in tombstones || selectTextFor != null) return
        messageSheet = SheetTarget(message, linkHref)
    }

    fun closeMessageSheet() { messageSheet = null }

    /** The sheet's items for [target] (held deletes: Select / Info / Delete). */
    fun sheetActionsFor(target: SheetTarget): List<SheetAction> {
        val m = target.message
        if (m.id in deleteHolds) return deletedMessageActions()
        return sheetOrder(
            messageSheetActions(
                m,
                SheetContext(chat = sheetChat, linkHref = target.linkHref, canShareLink = shareText != null),
            ),
        )
    }

    fun canDeleteForAllIds(ids: List<Long>): Boolean = canDeleteForAll(sheetChat, ids.map { msgById(it) })

    /** Tracking-param stripping (stable trackers.js; default on). */
    val stripTrackers: Boolean get() = platform.pref("velta-strip-trackers") != "0"

    /** Own-reaction toggle with optimistic chips (stable _toggleReaction). */
    fun react(message: MessageObject, emoji: String) {
        val veltaCore = core
        val id = accountId
        messageSheet = null
        if (veltaCore == null || id == null) return
        val live = msgById(message.id) ?: message
        val plan = reactionToggle(reactionChips(live.reactions), emoji)
        scope.launch {
            try {
                veltaCore.sendReaction(id, message.id, plan.send)
                reloadOpenChat()
            } catch (t: Throwable) {
                println("velta-kmp: react failed: $t")
            }
        }
    }

    fun startReply(message: MessageObject) {
        if (sheetChat.readOnly) return
        editingMsg = null
        replyTo = message
        messageSheet = null
    }

    /** stable _setEdit: the composer takes the text; Send edits instead. */
    fun startEdit(message: MessageObject) {
        if (!canEditMsg(message) || pendingAttachment != null) return
        replyTo = null
        editingMsg = message
        composerText = message.text
        messageSheet = null
    }

    fun cancelEdit() {
        if (editingMsg != null) composerText = ""
        editingMsg = null
    }

    private fun sendEdit(editing: MessageObject, text: String) {
        val veltaCore = core ?: return
        val id = accountId ?: return
        editingMsg = null
        composerText = ""
        scope.launch {
            try {
                veltaCore.sendEditRequest(id, editing.id, text)
                reloadOpenChat()
            } catch (t: Throwable) {
                showToast(L.t("Couldn't edit message: ") + (t.message ?: t.toString()), 4000)
            }
        }
    }

    fun saveSticker(message: MessageObject) {
        val veltaCore = core ?: return
        val id = accountId ?: return
        scope.launch {
            try {
                veltaCore.saveSticker(id, message.id)
                showToast(L.t("Sticker saved"))
            } catch (t: Throwable) {
                showToast(L.t("Couldn't save: ") + (t.message ?: t.toString()), 4000)
            }
        }
    }

    /** stable _saveAttachment: fetch a server-side file first, then hand
     *  the blob to the platform save path. */
    fun downloadAttachment(message: MessageObject) {
        val veltaCore = core ?: return
        val id = accountId ?: return
        scope.launch {
            try {
                var msg = msgById(message.id) ?: message
                val ds = msg.downloadState ?: "Done"
                if (ds != "Done") {
                    if (ds == "InProgress") { showToast(L.t("Still downloading…")); return@launch }
                    veltaCore.downloadFullMessage(id, msg.id)
                    msg = veltaCore.messages(id, listOf(msg.id)).firstOrNull() ?: msg
                    reloadOpenChat()
                }
                val path = msg.file ?: return@launch
                val save = saveFile ?: return@launch
                val name = msg.fileName ?: path.substringAfterLast('/')
                val err = save(path, name, msg.fileMime)
                when {
                    err == null -> showToast(L.t("Saved"))
                    err.contains("cancel", ignoreCase = true) -> {}
                    else -> showToast(L.t("Couldn't save: ") + err, 4000)
                }
            } catch (t: Throwable) {
                val text = t.message ?: t.toString()
                if (!text.contains("cancel", ignoreCase = true)) showToast(L.t("Couldn't save: ") + text, 4000)
            }
        }
    }

    fun togglePin(message: MessageObject) {
        val veltaCore = core ?: return
        val id = accountId ?: return
        val pinned = message.isPinned
        scope.launch {
            try {
                veltaCore.setPinned(id, message.id, !pinned)
                reloadOpenChat()
            } catch (t: Throwable) {
                showToast((if (pinned) L.t("Couldn't unpin: ") else L.t("Couldn't pin: ")) + (t.message ?: t.toString()), 4000)
            }
        }
    }

    /** stable _resendMessage: resend_messages re-queues our own message. */
    fun resend(message: MessageObject) {
        val veltaCore = core ?: return
        val id = accountId ?: return
        scope.launch {
            try {
                veltaCore.resendMessages(id, listOf(message.id))
                reloadOpenChat()
            } catch (t: Throwable) {
                showToast(L.t("Resend failed: {why}").replace("{why}", t.message ?: t.toString()), 4000)
            }
        }
    }

    /** stable starMessages: one ("Saved") or the selection ("Saved to Saved Messages"). */
    fun saveToSaved(ids: List<Long>, fromSelection: Boolean = false) {
        val veltaCore = core ?: return
        val id = accountId ?: return
        scope.launch {
            try {
                veltaCore.saveMessages(id, ids)
                showToast(if (fromSelection) L.t("Saved to Saved Messages") else L.t("Saved"))
                if (fromSelection) exitSelection()
                refreshChats()
            } catch (t: Throwable) {
                val msg = t.message ?: t.toString()
                showToast((if (fromSelection) L.t("Couldn't save messages: ") else L.t("Couldn't save message: ")) + msg, 4000)
            }
        }
    }

    fun startForward(ids: List<Long>) {
        messageSheet = null
        if (ids.isNotEmpty()) forwardIds = ids
    }

    /** stable forwardFlow pick: forward, leave selection, toast. */
    fun forwardTo(chat: ChatListItem) {
        val ids = forwardIds ?: return
        forwardIds = null
        val veltaCore = core ?: return
        val id = accountId ?: return
        scope.launch {
            try {
                veltaCore.forwardMessages(id, ids, chat.id)
                exitSelection()
                showToast(L.t("Forwarded to {name}").replace("{name}", chat.name))
                refreshChats()
            } catch (t: Throwable) {
                showToast(t.message ?: t.toString(), 4000)
            }
        }
    }

    /** Forward targets: stable drops the contact-request deaddrop + device chat. */
    fun forwardTargets(): List<ChatListItem> =
        chats.filter { it.kind == "ChatListItem" && !it.isDeviceTalk && !it.isContactRequest && it.id > 9 }

    fun showInfo(message: MessageObject) {
        messageSheet = null
        val m = msgById(message.id) ?: message
        messageInfo = MessageInfoData(m)
        val veltaCore = core ?: return
        val id = accountId ?: return
        scope.launch {
            val extra = runCatching { veltaCore.messageInfoObject(id, m.id) }.getOrNull()
            if (messageInfo?.message?.id == m.id) {
                messageInfo = messageInfo?.copy(rfc724Mid = extra?.first ?: "", serverUrls = extra?.second ?: emptyList())
            }
        }
    }

    fun startSelectText(message: MessageObject) {
        messageSheet = null
        selectTextFor = message
    }

    // ---- Selection mode (stable _enterSelection / _toggleSelect) ----

    fun enterSelection(messageId: Long) {
        messageSheet = null
        if (messageId !in selection) selection = selection + messageId
    }

    fun toggleSelect(messageId: Long) {
        selection = if (messageId in selection) selection - messageId else selection + messageId
    }

    fun exitSelection() { selection = emptyList() }

    /** Selection bar actions (index.html .sel-actions: reply, forward, copy,
     *  star, delete, info). Copy is UI-side (clipboard) — see [selectionText]. */
    fun selectionReply() {
        val first = selection.firstOrNull()?.let { msgById(it) }
        if (first != null) startReply(first)
        exitSelection()
    }

    fun selectionText(): Pair<String, Int> {
        val texts = selection.mapNotNull { msgById(it)?.text?.takeIf { t -> t.isNotEmpty() } }
        return texts.joinToString("\n") to texts.size
    }

    fun selectionInfo() {
        selection.firstOrNull()?.let { msgById(it) }?.let { showInfo(it) }
    }

    // ---- Delete with undo (stable _delete / _holdDelete / _commitDelete) ----

    /** Inline sheet confirm or the modal: hold, then commit after the window. */
    fun applyDeleteChoice(ids: List<Long>, choice: DeleteChoice) {
        if (choice == DeleteChoice.Cancel) return
        messageSheet = null
        deleteConfirmIds = null
        holdDelete(ids, choice == DeleteChoice.ForEveryone)
        exitSelection()
    }

    private fun holdDelete(ids0: List<Long>, forAll: Boolean) {
        val chatId = currentChatId() ?: return
        val ids = ids0.filter { msgById(it) != null && it !in deleteHolds }
        if (ids.isEmpty()) return
        val key = ++deleteSeq
        val hold = DeleteHold(key, forAll, wallClockMillis(), DELETE_UNDO_MS)
        deleteHolds = deleteHolds + ids.associateWith { hold }
        deleteBatchIds[key] = chatId to ids
        deleteJobs[key] = scope.launch {
            delay(DELETE_UNDO_MS)
            commitDelete(key)
        }
    }

    /** Undo on any message of a batch restores the whole batch. */
    fun undoDelete(messageId: Long) {
        val hold = deleteHolds[messageId] ?: return
        if (hold.committing) return
        deleteJobs.remove(hold.key)?.cancel()
        val ids = deleteBatchIds.remove(hold.key)?.second ?: listOf(messageId)
        deleteHolds = deleteHolds - ids.toSet()
    }

    /** The sheet's Delete on a held message: commit now (stable _commitDelete). */
    fun commitDeleteNow(messageId: Long) {
        val hold = deleteHolds[messageId] ?: return
        messageSheet = null
        scope.launch { commitDelete(hold.key) }
    }

    private suspend fun commitDelete(key: Int) {
        val (chatId, ids) = deleteBatchIds[key] ?: return
        val hold = ids.firstNotNullOfOrNull { deleteHolds[it] }?.takeIf { it.key == key } ?: return
        if (hold.committing) return
        deleteJobs.remove(key)?.cancel()
        deleteBatchIds.remove(key)
        val veltaCore = core
        val id = accountId
        tombstones = tombstones + ids
        deleteHolds = deleteHolds - ids.toSet()
        if (veltaCore == null || id == null) return
        try {
            veltaCore.deleteMessages(id, ids, hold.forAll)
            exitSelection()
            refreshChats()
            if (currentChatId() == chatId) reloadOpenChat()
        } catch (t: Throwable) {
            tombstones = tombstones - ids.toSet()
            showToast(L.t("Couldn't delete messages: ") + (t.message ?: t.toString()), 4500)
        }
    }

    /** Leaving the chat commits a confirmed delete (stable _flushPendingDeletes). */
    private fun flushPendingDeletes() {
        val keys = deleteBatchIds.keys.toList()
        for (key in keys) {
            deleteJobs.remove(key)?.cancel()
            scope.launch { commitDelete(key) }
        }
    }

    /** Reset per-chat sheet state (open / leave a chat). */
    private fun resetChatActions() {
        flushPendingDeletes()
        messageSheet = null
        selection = emptyList()
        editingMsg = null
        forwardIds = null
        messageInfo = null
        selectTextFor = null
        deleteConfirmIds = null
        tombstones = emptySet()
        chatMenu = null
        chatConfirm = null
        groupInvite = null
    }

    // ---- Chat menus (#334 step 5, app.js chatContextMenu / bindChatHeadMenu) ----

    /** An open chat menu: the list long-press / right-click menu or the ⋮
     *  head menu, anchored at a window point (px). [spans] = the
     *  "Delete old messages…" second menu at the same point. */
    data class ChatMenuState(
        val chat: MenuChat,
        val entries: List<ChatMenuEntry>,
        val x: Float,
        val y: Float,
        val head: Boolean = false,
        val spans: Boolean = false,
    )

    var chatMenu by mutableStateOf<ChatMenuState?>(null)

    /** A stable confirmModal waiting for an answer. */
    data class PendingConfirm(val spec: ConfirmSpec, val onOk: () -> Unit)

    var chatConfirm by mutableStateOf<PendingConfirm?>(null)

    /** ui.js showInvite for a group: link null while the core works. */
    data class GroupInviteState(val chatId: Long, val name: String, val link: String? = null, val error: String? = null)

    var groupInvite by mutableStateOf<GroupInviteState?>(null)

    private fun chatItemById(chatId: Long): ChatListItem? =
        chats.firstOrNull { it.id == chatId } ?: archivedChats.firstOrNull { it.id == chatId }

    /** The open chat as the head menu sees it (stable activeChat()). */
    fun activeMenuChat(): MenuChat? {
        val open = screen as? Screen.Chat ?: return null
        val adminId = sheetChat.groupAdminId
        chatItemById(open.chatId)?.let { return menuChatOf(it, adminId) }
        return MenuChat(
            id = open.chatId,
            name = open.title,
            kind = when {
                sheetChat.isSaved -> "saved"
                open.isGroup || sheetChat.isGroup -> "group"
                else -> "single"
            },
            groupAdminId = adminId,
        )
    }

    fun openChatListMenu(item: ChatListItem, x: Float, y: Float) {
        val chat = menuChatOf(item)
        chatMenu = ChatMenuState(chat, chatListMenu(chat), x, y)
    }

    fun openChatHeadMenu(x: Float, y: Float) {
        val chat = activeMenuChat() ?: return
        chatMenu = ChatMenuState(chat, chatHeadMenu(chat), x, y, head = true)
    }

    fun closeChatMenu() {
        chatMenu = null
    }

    fun onChatMenuAction(action: ChatAction) {
        val menu = chatMenu ?: return
        val chat = menu.chat
        if (action == ChatAction.DeleteOld) {
            // Stable re-opens a second menu at the same point.
            chatMenu = menu.copy(spans = true)
            return
        }
        chatMenu = null
        when (action) {
            ChatAction.TogglePin -> chatFlags(chat.id, pinned = !chat.pinned)
            ChatAction.ToggleMute -> chatMute(chat.id, !chat.muted)
            ChatAction.ToggleArchive -> chatFlags(chat.id, archived = !chat.archived)
            ChatAction.MarkRead -> markChatRead(chat.id)
            ChatAction.DeleteChat -> chatConfirm = PendingConfirm(deleteChatConfirm(chat)) { deleteChatNow(chat) }
            ChatAction.ChatInfo -> openProfile(chat.id, chat.name)
            ChatAction.GroupInviteQr -> showGroupInvite(chat)
            ChatAction.LeaveGroup -> chatConfirm = PendingConfirm(leaveConfirm(chat)) { leaveGroupNow(chat) }
            ChatAction.ClearHistory -> chatConfirm = PendingConfirm(CLEAR_HISTORY_CONFIRM) { clearHistoryNow(chat) }
            ChatAction.DeleteOld -> Unit
        }
    }

    /** A span picked in the "Delete old messages…" menu. */
    fun onDeleteOldSpan(label: String, ageMs: Long, translatedLabel: String) {
        val chat = chatMenu?.chat ?: return
        chatMenu = null
        chatConfirm = PendingConfirm(deleteOldConfirm(chat, translatedLabel)) {
            deleteOlderNow(chat, wallClockMillis() - ageMs)
        }
    }

    fun answerChatConfirm(ok: Boolean) {
        val pending = chatConfirm ?: return
        chatConfirm = null
        if (ok) pending.onOk()
    }

    /** Runs [block] for the account that was current when the action began
     *  (stable accountIsCurrent(epoch)); errors go to a toast. */
    private fun chatJob(errorPrefix: String?, block: suspend (VeltaCore, Long) -> Unit) {
        val veltaCore = core ?: return
        val id = accountId ?: return
        scope.launch {
            try {
                block(veltaCore, id)
            } catch (t: Throwable) {
                println("velta-kmp: chat action failed: $t")
                if (errorPrefix != null && accountId == id) showToast(errorPrefix + (t.message ?: t.toString()), 4000)
            } finally {
                if (accountId == id) refreshChats()
            }
        }
    }

    /** rpc-core setChatFlags pin / archive. */
    fun chatFlags(chatId: Long, pinned: Boolean? = null, archived: Boolean? = null) =
        chatJob(null) { c, id -> c.setChatVisibility(id, chatId, visibilityFor(pinned, archived)) }

    /** rpc-core setChatFlags mute (Forever / NotMuted). */
    fun chatMute(chatId: Long, muted: Boolean) =
        chatJob(null) { c, id -> c.setChatMute(id, chatId, muteKind(muted)) }

    fun markChatRead(chatId: Long) =
        chatJob(null) { c, id -> c.marknoticedChat(id, chatId) }

    private fun deleteChatNow(chat: MenuChat) = chatJob(L.t("Couldn't delete chat: ")) { c, id ->
        if (deleteChatLeavesFirst(chat)) runCatching { c.leaveGroup(id, chat.id) }
        if (accountId != id) return@chatJob
        c.deleteChat(id, chat.id)
        if (accountId == id && (screen as? Screen.Chat)?.chatId == chat.id) backToChatList()
    }

    private fun leaveGroupNow(chat: MenuChat) = chatJob(L.t("Couldn't leave: ")) { c, id ->
        c.leaveGroup(id, chat.id)
        // The left chat turns read-only in place (stable hides the composer).
        if (accountId == id && (screen as? Screen.Chat)?.chatId == chat.id) sheetChat = sheetChat.copy(readOnly = true)
    }

    private fun clearHistoryNow(chat: MenuChat) = chatJob(null) { c, id ->
        val ids = c.messageIds(id, chat.id)
        ids.chunked(DELETE_CHUNK).forEach { if (accountId == id) c.deleteMessages(id, it, forAll = false) }
        if (accountId == id && (screen as? Screen.Chat)?.chatId == chat.id) loadMessages(chat.id)
    }

    private fun deleteOlderNow(chat: MenuChat, cutoffMs: Long) = chatJob(L.t("Couldn't delete: ")) { c, id ->
        val all = c.messageIds(id, chat.id)
        val old = ArrayList<Long>()
        for (page in all.chunked(500)) {
            if (accountId != id) return@chatJob
            old += idsOlderThan(c.messages(id, page).map { Triple(it.id, it.timestamp, it.isPinned) }, cutoffMs)
        }
        var deleted = 0
        for (chunk in old.chunked(DELETE_CHUNK)) {
            if (accountId != id) break
            c.deleteMessages(id, chunk, forAll = false)
            deleted += chunk.size
        }
        if (accountId != id) return@chatJob
        showToast(
            when (deletedToastKey(deleted)) {
                "Nothing older than that" -> L.t("Nothing older than that")
                "1 message deleted" -> L.t("1 message deleted")
                else -> L.t("Messages deleted: {n}").replace("{n}", deleted.toString())
            },
        )
        if ((screen as? Screen.Chat)?.chatId == chat.id) loadMessages(chat.id)
    }

    /** chat-view.js `_sendArchivedAware`: writing in an archived chat
     *  unarchives it (only in the account that sent). */
    private suspend fun unarchiveAfterSend(veltaCore: VeltaCore, id: Long, chatId: Long) {
        if (accountId != id || archivedChats.none { it.id == chatId }) return
        try {
            veltaCore.setChatVisibility(id, chatId, "Normal")
            refreshChats()
        } catch (_: Throwable) { /* core refused — keep the flag as is */ }
    }

    private fun acceptContactRequest(item: ChatListItem) = chatJob(null) { c, id ->
        c.acceptChat(id, item.id)
        if (accountId != id) return@chatJob
        showToast(L.t("Contact request accepted"))
        openChat(item.copy(isContactRequest = false))
    }

    fun showGroupInvite(chat: MenuChat) {
        groupInvite = GroupInviteState(chat.id, chat.name)
        val veltaCore = core ?: return
        val id = accountId ?: return
        scope.launch {
            try {
                val link = veltaCore.inviteQr(id, chat.id).first
                if (groupInvite?.chatId == chat.id) groupInvite = groupInvite?.copy(link = link)
            } catch (t: Throwable) {
                if (groupInvite?.chatId == chat.id) groupInvite = groupInvite?.copy(error = t.message ?: t.toString())
            }
        }
    }

    // ---- Share-in (#334 step 7, app.js offerShare / deliverShare) ----

    /** Shares that arrived before the app could show them (a cold start
     *  from the share sheet): held until the chat list is up, then one
     *  picker per burst, never two at a time (share-in createShareInbox). */
    private val heldShares = ArrayList<ShareItem>()

    /** The open "Share to…" picker's burst. */
    var sharePick by mutableStateOf<SharePlan?>(null)

    fun receiveShare(items: List<ShareItem>) {
        val batch = items.filter { it.text != null || it.file != null }
        if (batch.isEmpty()) return
        synchronized(heldShares) { heldShares += batch }
        flushShares()
    }

    private fun shareReady(): Boolean =
        connected && accountId != null && !locked && screen != Screen.Login

    fun flushShares() {
        if (!shareReady() || sharePick != null) return
        val batch = synchronized(heldShares) {
            if (heldShares.isEmpty()) return
            heldShares.toList().also { heldShares.clear() }
        }
        sharePick = sharePlan(batch)
        ensureContactBots()
        loadShareAccounts()
    }

    private fun loadShareAccounts() {
        val veltaCore = core ?: return
        scope.launch { runCatching { accounts = veltaCore.allAccounts() } }
    }

    fun cancelShare() {
        sharePick = null
        flushShares()
    }

    /** Picker profile chip: switch, then the picker re-lists that profile. */
    fun pickShareAccount(id: Long) {
        val veltaCore = core ?: return
        scope.launch {
            try {
                switchAccountNow(veltaCore, id)
            } catch (t: Throwable) {
                showToast(L.t("Switch failed: ") + (t.message ?: t.toString()), 4000)
            }
        }
    }

    fun shareTargetsFor(query: String, cat: String): List<ChatListItem> = shareTargets(chats, query, cat, ::chatIsBot)

    /** Open the picked chat and hand it the share (chat-view receiveShare):
     *  text and one photo/video go to the composer, documents and several
     *  files are sent right away ("Sent to {name}"). */
    fun pickShareChat(chat: ChatListItem) {
        val plan = sharePick ?: return
        sharePick = null
        val veltaCore = core ?: return
        val id = accountId ?: return
        openChat(chat)
        scope.launch {
            try {
                val full = runCatching { veltaCore.fullChat(id, chat.id) }.getOrNull()
                if (full != null && (full["canSend"] as? kotlinx.serialization.json.JsonPrimitive)?.content == "false") {
                    val msg = "You can't write in this chat" // stable has no translation either
                    throw IllegalStateException(L.t(msg))
                }
                if (accountId != id) return@launch
                val names = plan.files.map { it.name ?: it.file!!.substringAfterLast('/') }
                when (val kind = shareStageKind(names)) {
                    "text", "image", "video" -> {
                        if (kind != "text") pendingAttachment = plan.files[0].file!! to names[0]
                        composerText = composerWithShare(composerText, plan.text)
                    }
                    else -> {
                        if (plan.files.size == 1) {
                            veltaCore.sendMessage(id, chat.id, plan.text, coreViewtype(shareViewtype(names[0])), plan.files[0].file, names[0])
                        } else {
                            if (plan.text.isNotEmpty()) veltaCore.sendMessage(id, chat.id, plan.text)
                            plan.files.forEachIndexed { i, f ->
                                if (accountId == id) veltaCore.sendMessage(id, chat.id, "", coreViewtype(shareViewtype(names[i])), f.file, names[i])
                            }
                        }
                        if (accountId != id) return@launch
                        unarchiveAfterSend(veltaCore, id, chat.id)
                        showToast(L.t("Sent to {name}").replace("{name}", chat.name))
                        refreshChats()
                        if ((screen as? Screen.Chat)?.chatId == chat.id) loadMessages(chat.id)
                    }
                }
            } catch (t: Throwable) {
                println("velta-kmp: share failed: $t")
                if (accountId == id) showToast(L.t("Couldn't share: ") + (t.message ?: t.toString()), 4000)
            } finally {
                flushShares()
            }
        }
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
                if (accountId == id) chatMembers = chatMembers + (chatId to members)
            } catch (t: Throwable) {
                println("velta-kmp: chat members for $chatId failed: $t")
            }
        }
    }

    /** Sticker packs, fetched once per profile on first composer open. */
    fun loadStickers() {
        if (stickerPacks.isNotEmpty()) return
        val veltaCore = core
        val id = accountId
        if (veltaCore == null || id == null) return
        scope.launch {
            try {
                val packs = veltaCore.getStickers(id)
                if (accountId == id) stickerPacks = packs
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
                unarchiveAfterSend(veltaCore, id, chat.chatId)
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
    private var dirtyList = false
    private var dirtyHead = false
    private var reloadJob: Job? = null

    /** [chatId] null = every chat (core uses 0 / absent for "many"). */
    private fun scheduleChatReload(chatId: Long?, listOnly: Boolean = false, head: Boolean = false) {
        synchronized(reloadLock) {
            when {
                listOnly -> dirtyList = true
                chatId == null -> dirtyAllChats = true
                else -> dirtyChatIds += chatId
            }
            if (head) dirtyHead = true
            if (reloadJob == null) {
                reloadJob = scope.launch { flushReloads() }
            }
        }
    }

    private suspend fun flushReloads() {
        delay(200)
        val snapshot = synchronized(reloadLock) {
            val s = ReloadSnapshot(dirtyChatIds.toSet(), dirtyAllChats, dirtyList, dirtyHead)
            dirtyChatIds.clear()
            dirtyAllChats = false
            dirtyList = false
            dirtyHead = false
            reloadJob = null
            s
        }
        when (val current = screen) {
            is Screen.Chat -> {
                if (snapshot.all || current.chatId in snapshot.ids) {
                    loadMessages(current.chatId, current.isGroup)
                }
                if (snapshot.head) refreshOpenChatHead(current)
            }
            Screen.ChatList -> if (snapshot.all || snapshot.ids.isNotEmpty() || snapshot.list) loadChats()
            else -> {}
        }
    }

    private data class ReloadSnapshot(val ids: Set<Long>, val all: Boolean, val list: Boolean, val head: Boolean)

    /** Name/avatar/member changes of the open chat: re-read its list item. */
    private suspend fun refreshOpenChatHead(current: Screen.Chat) {
        val veltaCore = core ?: return
        val id = accountId ?: return
        val item = runCatching { veltaCore.chatlistItems(id, listOf(current.chatId)).firstOrNull() }
            .getOrNull() ?: return
        if ((screen as? Screen.Chat)?.chatId != current.chatId) return
        if (item.name != current.title) screen = current.copy(title = item.name)
        loadChatHead(item)
    }

    /**
     * Live updates (#334). Events carry the ACCOUNT in `contextId`: only the
     * account on screen reloads UI; every account notifies. chatId 0/absent
     * means "many chats".
     */
    internal suspend fun handleEvent(event: CoreEvent) {
        val eventAccount = event.accountId ?: accountId
        val forCurrent = eventAccount == accountId
        val chatId = event.chatId()?.takeIf { it > 0L }
        when (event.kind) {
            "ConnectivityChanged" -> if (forCurrent) refreshRelayLine()
            "ConfigureProgress" -> {
                val comment = event.event?.get("comment")?.toString()?.trim('"')
                if (!comment.isNullOrBlank() && comment != "null") loginProgress = comment
                event.event?.get("progress")?.toString()?.toIntOrNull()?.let { onConfigureProgress(it) }
            }
            "ImexProgress" -> event.event?.get("progress")?.toString()?.toIntOrNull()?.let { onImexProgress(it) }
            "IncomingMsg" -> {
                if (forCurrent) scheduleChatReload(chatId)
                if (eventAccount != null && chatId != null) notifyIncoming(eventAccount, chatId, event)
            }
            "MsgsNoticed" -> {
                // Read here or on another device: the notification is stale.
                if (eventAccount != null && chatId != null) notifier?.cancel(eventAccount, chatId)
                if (forCurrent) scheduleChatReload(chatId)
            }
            "MsgsChanged", "MsgDelivered", "MsgFailed", "MsgRead", "MsgReadCountChanged",
            "MsgDeleted", "ReactionsChanged", "IncomingReaction", "ChatEphemeralTimerModified",
            -> if (forCurrent) scheduleChatReload(chatId)
            "ChatModified" -> if (forCurrent) {
                scheduleChatReload(chatId, head = chatId != null && (screen as? Screen.Chat)?.chatId == chatId)
                scheduleChatReload(null, listOnly = true)
            }
            "ChatlistItemChanged" -> if (forCurrent) {
                if (chatId == null) scheduleChatReload(null, listOnly = true) else scheduleChatReload(chatId)
            }
            "ChatlistChanged" -> if (forCurrent) scheduleChatReload(null, listOnly = true)
            "ContactsChanged", "IncomingMsgBunch" -> if (forCurrent) {
                // Names/avatars may change in any chat (sender names are
                // re-resolved on every group load; the head re-reads).
                scheduleChatReload(null, head = event.kind == "ContactsChanged")
            }
            "CallEnded" -> if (forCurrent) chatId?.let { recordCallEnded(it) }
        }
    }

    /** Conversation notification for an incoming message — skipped only for
     * the chat on screen while the app is in the foreground, and for muted
     * chats. Works for every account, not just the one on screen. */
    private suspend fun notifyIncoming(eventAccount: Long, chatId: Long, event: CoreEvent) {
        val current = screen
        if (appInForeground && eventAccount == accountId && current is Screen.Chat && current.chatId == chatId) return
        val n = notifier ?: return
        val veltaCore = core ?: return
        val item = runCatching { veltaCore.chatlistItems(eventAccount, listOf(chatId)).firstOrNull() }.getOrNull()
        if (item?.isMuted == true) return
        val msgId = event.event?.get("msgId")?.toString()?.trim('"')?.toLongOrNull()
        val text = msgId?.let { mid ->
            runCatching { veltaCore.messages(eventAccount, listOf(mid)).firstOrNull()?.text }.getOrNull()
        } ?: ""
        val fallback = L.t("New message")
        n.notifyIncoming(eventAccount, chatId, item?.name?.ifBlank { null } ?: fallback, text.ifBlank { fallback })
    }

    // ---- Foreground + read receipts + notification taps (#334) ----

    /** Android onStart/onStop. Coming back with a chat open re-reads it so
     * the visible rows get marked seen and its notification goes away. */
    fun onAppForeground(visible: Boolean) {
        appInForeground = visible
        if (!visible) {
            hiddenAtMillis = if (!locked && autoLockMins > 0 && platform.isAppLockOn()) clockMillis() else null
            return
        }
        val hiddenAt = hiddenAtMillis
        hiddenAtMillis = null
        if (LockPolicy.shouldAutoLock(hiddenAt, clockMillis(), autoLockMins)) {
            lockNow()
            return
        }
        if (locked) return
        val current = screen as? Screen.Chat ?: return
        accountId?.let { notifier?.cancel(it, current.chatId) }
        loadMessages(current.chatId, current.isGroup)
    }

    /**
     * The chat view reports the message ids on screen; unseen incoming ones
     * go to markseen_msgs (read receipts, IMAP \Seen) — once each, only
     * while the app is visible and that chat is open (web markSeen).
     */
    fun onMessagesVisible(ids: Collection<Long>) {
        val current = screen as? Screen.Chat ?: return
        val veltaCore = core ?: return
        val id = accountId ?: return
        if (!appInForeground || ids.isEmpty()) return
        val wanted = ids.toSet()
        val fresh = chatMessages.filter { it.id in wanted && it.chatId == current.chatId && isUnseenIncoming(it) }
            .map { it.id }
            .filter { synchronized(seenSent) { seenSent.add(it) } }
        if (fresh.isEmpty()) return
        scope.launch {
            try {
                veltaCore.markseenMsgs(id, fresh)
            } catch (t: Throwable) {
                synchronized(seenSent) { seenSent.removeAll(fresh.toSet()) }
                println("velta-kmp: markseen failed: $t")
            }
        }
    }

    /** A notification tap: open [chatId] of [accountId] (switching account
     * if needed) now, or as soon as the core + chat list are up. */
    fun openFromNotification(accountId: Long?, chatId: Long) {
        if (chatId <= 0L) return
        pendingOpen = PendingOpen(accountId, chatId)
        if (connected && this.accountId != null && screen != Screen.Login) consumePendingOpen()
    }

    private fun consumePendingOpen() {
        val wanted = pendingOpen ?: return
        val veltaCore = core ?: return
        pendingOpen = null
        scope.launch {
            val current = accountId
            if (wanted.accountId != null && wanted.accountId != current) {
                switchAccountNow(veltaCore, wanted.accountId)
            }
            val id = accountId ?: return@launch
            val item = chats.firstOrNull { it.id == wanted.chatId }
                ?: archivedChats.firstOrNull { it.id == wanted.chatId }
                ?: runCatching { veltaCore.chatlistItems(id, listOf(wanted.chatId)).firstOrNull() }.getOrNull()
            if (item != null) openChat(item) else println("velta-kmp: notification chat ${wanted.chatId} not found")
        }
    }

    private fun CoreEvent.chatId(): Long? =
        (event?.get("chatId")?.toString())?.trim('"')?.toLongOrNull()
            ?: (event?.get("chat_id")?.toString())?.trim('"')?.toLongOrNull()
}
