package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.velta.kmp.core.CoreEvent
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.ObStep
import org.velta.kmp.ui.Onboarding
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #334: stable's welcome splash — create paths, autopick, invites, second device. */
class OnboardingTest {

    private fun script(extra: Map<String, String> = emptyMap()) = mapOf(
        "get_system_info" to """{"deltachat_core_version":"v2.69.0"}""",
        "get_all_account_ids" to "[]",
        "get_selected_account_id" to "null",
        "add_account" to "1",
        "is_configured" to "false",
        "add_device_message" to "1",
        "init_transports" to "null",
        "add_transport_from_qr" to "null",
        "add_transport" to "null",
        "get_backup" to "null",
        "start_io_for_all_accounts" to "null",
        "set_config" to "null",
        "get_account_info" to """{"id":1,"addr":"me@chat.example","isConfigured":true}""",
        "get_chatlist_entries" to "[]",
    ) + extra

    private class Fx(val t: ScriptedRpcTransport, val model: AppModel, val scope: CoroutineScope)

    private fun run(
        extra: Map<String, String> = emptyMap(),
        without: Set<String> = emptySet(),
        before: (AppModel) -> Unit = {},
        block: suspend Fx.() -> Unit,
    ) = runBlocking {
        val t = ScriptedRpcTransport(script(extra) - without)
        val platform = object : CorePlatform {
            override fun accountsDir() = "/tmp/velta-kmp-onboard-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = t
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(platform, scope)
        try {
            before(model)
            model.connect()
            withTimeout(10_000) { while (!model.connected || model.status != "connected") yield() }
            // #387: the screen holds Booting until resumeSession resolves.
            withTimeout(10_000) { while (model.screen == AppModel.Screen.Booting) yield() }
            assertEquals(AppModel.Screen.Login, model.screen)
            Fx(t, model, scope).block()
        } finally {
            scope.cancel()
        }
    }

    private fun ScriptedRpcTransport.calls(method: String) =
        requests.filter { "\"method\":\"$method\"" in it }
            .map { Json.parseToJsonElement(it).jsonObject["params"].toString() }

    private suspend fun Fx.awaitNickname() = withTimeout(10_000) { while (!model.askNickname) yield() }

    @Test
    fun relayLinksAndInvitesParseLikeStable() {
        assertEquals("dcaccount:https://nine.testrun.org/new", Onboarding.normalizeRelayLink("nine.testrun.org"))
        assertEquals("dcaccount:https://nine.testrun.org/new", Onboarding.normalizeRelayLink(" https://nine.testrun.org/x "))
        assertEquals("DCACCOUNT:https://a.example/new", Onboarding.normalizeRelayLink("DCACCOUNT:https://a.example/new"))
        assertNull(Onboarding.normalizeRelayLink("not a host"))
        assertNull(Onboarding.normalizeRelayLink(""))
        assertEquals(Onboarding.RelayInvite("relay.example", "Tok_en-1234"), Onboarding.parseRelayInvite("https://Relay.Example/i/Tok_en-1234/"))
        assertEquals(Onboarding.RelayInvite("relay.example", "Tok_en-1234"), Onboarding.parseRelayInvite("relay.example/i/Tok_en-1234"))
        assertNull(Onboarding.parseRelayInvite("https://relay.example/i/claim"))
        assertNull(Onboarding.parseRelayInvite("https://1.2.3.4/i/Tok_en-1234"))
        assertNull(Onboarding.parseRelayInvite("https://relay.example/i/short"))
        assertTrue(Onboarding.isBackupCode("DCBACKUP2:abc&x@y"))
        assertTrue(!Onboarding.isBackupCode("dcaccount:x"))
    }

    @Test
    fun claimStatusesMapToStableMessages() {
        assertEquals(Onboarding.Creds("a@b.c", "pw"), Onboarding.relayClaimResult(200, "a@b.c", "pw"))
        assertFailsWith<IllegalStateException> { Onboarding.relayClaimResult(200, "nope", "pw") }
        val used = assertFailsWith<IllegalStateException> { Onboarding.relayClaimResult(409, null, null) }
        assertTrue("already been used" in used.message!!)
        val other = assertFailsWith<IllegalStateException> { Onboarding.relayClaimResult(500, null, null) }
        assertTrue("(500)" in other.message!!)
    }

    @Test
    fun autopickUsesTheCorePoolAndAsksForANickname() = run {
        model.welcomeAutopick()
        awaitNickname()
        assertEquals(listOf("[1,null]"), t.calls("init_transports"), "core autorelay, no client hostnames")
        assertEquals(listOf("[1,\"core-welcome-image\",null]"), t.calls("add_device_message"))
        assertEquals("Account created — welcome!", model.obSteps.last().text)
        model.nicknameInput = "Pavel"
        model.finishNickname(true)
        withTimeout(10_000) { while (model.screen != AppModel.Screen.ChatList) yield() }
        assertEquals(listOf("[1,\"displayname\",\"Pavel\"]"), t.calls("set_config").filterNot { "download_limit" in it })
        assertEquals("Account created on chat.example", model.createdNotice)
    }

    @Test
    fun relayAddressCreatesViaDcaccountLink() = run {
        model.welcomeShowCreate()
        model.relayInput = "nine.testrun.org"
        model.welcomeSubmit()
        awaitNickname()
        assertEquals(listOf("[1,\"dcaccount:https://nine.testrun.org/new\"]"), t.calls("add_transport_from_qr"))
        assertEquals("Attempting to connect to relay at nine.testrun.org", model.obSteps.first().text)
        model.finishNickname(false)
        withTimeout(10_000) { while (model.screen != AppModel.Screen.ChatList) yield() }
        assertTrue(t.calls("set_config").filterNot { "download_limit" in it }.isEmpty(), "Skip sets no name")
    }

    @Test
    fun badInputIsRejectedWithStableCopy() = run {
        model.relayInput = "  "
        model.welcomeSubmit()
        assertEquals("Enter a relay address", model.welcomeNotice)
        model.relayInput = "hello world"
        model.welcomeSubmit()
        assertEquals("That doesn't look like a relay or invite address", model.welcomeNotice)
        assertTrue(t.calls("add_account").isEmpty())
    }

    @Test
    fun relayInviteClaimsOnceAndConfiguresWithCredentials() = run {
        val urls = mutableListOf<String>()
        model.httpGet = { url -> urls += url; 200 to """{"email":"x@relay.example","password":"pw"}""" }
        model.relayInput = "https://relay.example/i/Tok_en-1234"
        model.welcomeSubmit()
        awaitNickname()
        assertEquals(listOf("https://relay.example/i/claim?t=Tok_en-1234"), urls)
        assertEquals(listOf("[1,{\"addr\":\"x@relay.example\",\"password\":\"pw\"}]"), t.calls("add_transport"))
    }

    @Test
    fun aFailedConfigureRetriesWithoutBurningTheInvite() = run(extra = mapOf("add_transport" to "ERROR:relay down")) {
        var claims = 0
        model.httpGet = { claims++; 200 to """{"email":"x@relay.example","password":"pw"}""" }
        model.relayInput = "relay.example/i/Tok_en-1234"
        repeat(2) {
            model.welcomeSubmit()
            withTimeout(10_000) { while (!model.obFailed || model.obBusy) yield() }
            assertEquals(ObStep.State.Failed, model.obSteps.last().state)
            assertTrue(model.obSteps.last().text.startsWith("Setup failed: "))
        }
        assertEquals(1, claims, "the single-use invite is claimed once; creds are parked")
        assertEquals(2, t.calls("add_transport").size)
    }

    @Test
    fun claimErrorsShowStableReasons() = run {
        model.httpGet = { 410 to "" }
        model.relayInput = "relay.example/i/Tok_en-1234"
        model.welcomeSubmit()
        withTimeout(10_000) { while (!model.obFailed) yield() }
        assertTrue("expired" in model.obSteps.last().text, model.obSteps.toString())
    }

    @Test
    fun secondDeviceCodeFromAScanReceivesTheProfile() = run {
        model.onQrScanned("DCBACKUP2:token&me@chat.example")
        withTimeout(10_000) { while (model.screen != AppModel.Screen.ChatList) yield() }
        assertEquals(listOf("[1,\"DCBACKUP2:token&me@chat.example\"]"), t.calls("get_backup"))
    }

    @Test
    fun aLinkBeforeTheCoreIsUpWaitsForIt() = run(before = { it.onQrScanned("nine.testrun.org") }) {
        awaitNickname()
        assertEquals(listOf("[1,\"dcaccount:https://nine.testrun.org/new\"]"), t.calls("add_transport_from_qr"))
    }

    @Test
    fun relayCardConfirmCreatesANewAccount() = run(extra = mapOf("select_account" to "null")) {
        val urls = mutableListOf<String>()
        model.httpGet = { url -> urls += url; 200 to """{"email":"x@relay.example","password":"pw"}""" }
        model.askRelayAccount("relay.example", "Tok_en-1234")
        assertEquals("Create an account on {host}?", model.chatConfirm?.spec?.title)
        model.answerChatConfirm(false)
        assertTrue(t.calls("add_account").isEmpty(), "cancel creates nothing")
        assertTrue(urls.isEmpty())
        model.askRelayAccount("relay.example", "Tok_en-1234")
        model.answerChatConfirm(true)
        withTimeout(10_000) { while (model.toast != "Account created on relay.example") yield() }
        assertEquals(AppModel.Screen.ChatList, model.screen)
        assertEquals(1L, model.accountId)
        assertEquals(listOf("https://relay.example/i/claim?t=Tok_en-1234"), urls)
        assertEquals(listOf("[1,{\"addr\":\"x@relay.example\",\"password\":\"pw\"}]"), t.calls("add_transport"))
        assertEquals(listOf("[1]"), t.calls("select_account"))
    }

    @Test
    fun configureProgressAddsPhaseLinesInOrder() = run(without = setOf("init_transports")) {
        // init_transports never answers here → the create stays in flight.
        model.welcomeAutopick()
        withTimeout(10_000) { while (t.calls("init_transports").isEmpty()) yield() }
        fun progress(p: Int) = Json.decodeFromString(
            CoreEvent.serializer(),
            """{"contextId":1,"event":{"kind":"ConfigureProgress","progress":$p,"comment":null}}""",
        )
        model.handleEvent(progress(1))
        model.handleEvent(progress(450))
        assertEquals(
            listOf(
                "Looking for a fast relay…" to ObStep.State.Done,
                "Found a relay that answers fast" to ObStep.State.Done,
                "Requesting new account credentials" to ObStep.State.Done,
                "Generating encryption keys" to ObStep.State.Active,
            ),
            model.obSteps.map { it.text to it.state },
        )
        assertTrue(model.obBusy)
    }
}
