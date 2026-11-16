package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.PUSH_OFF_VALUE
import org.velta.kmp.ui.PushApp
import org.velta.kmp.ui.PushBridge
import org.velta.kmp.ui.PushStatus
import org.velta.kmp.ui.describeLastPush
import org.velta.kmp.ui.describePushState
import org.velta.kmp.ui.describeRelaySupport
import org.velta.kmp.ui.pushOptions
import org.velta.kmp.ui.pushRegistration
import org.velta.kmp.ui.pushSelectedValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** #358 Background delivery item 4: stable push-settings.js. */
class PushSettingsRulesTest {
    private val ntfy = PushApp("io.heckel.ntfy", "ntfy")
    private val next = PushApp("org.unifiedpush.distributor.nextpush", "NextPush")

    @Test
    fun registrationOutcome() {
        assertEquals("none", pushRegistration(0, ""))
        assertEquals("ok", pushRegistration(5, ""))
        assertEquals("failed", pushRegistration(5, "NETWORK"), "a failure wins over an old endpoint")
    }

    @Test
    fun pickerRowsAndSelection() {
        assertEquals(emptyList(), pushOptions(PushStatus()))
        assertEquals("", pushSelectedValue(PushStatus()))
        val s = PushStatus(distributors = listOf(ntfy, next))
        assertEquals(listOf("io.heckel.ntfy", "org.unifiedpush.distributor.nextpush", PUSH_OFF_VALUE), pushOptions(s).map { it.first })
        assertEquals("Off", pushOptions(s).last().second)
        assertEquals(PUSH_OFF_VALUE, pushSelectedValue(s))
        assertEquals("io.heckel.ntfy", pushSelectedValue(s.copy(saved = "io.heckel.ntfy")))
    }

    @Test
    fun stateLine() {
        assertEquals("No push app installed — using periodic background checks", describePushState(PushStatus()))
        val s = PushStatus(distributors = listOf(ntfy))
        assertEquals("Off — pick a push app below", describePushState(s))
        assertEquals("Off — using periodic background checks", describePushState(s.copy(optedOut = true)))
        assertEquals("Using ntfy", describePushState(s.copy(saved = "io.heckel.ntfy")))
        assertEquals("Using Gone", describePushState(s.copy(saved = "x.gone", savedLabel = "Gone")))
        assertEquals("Registration failed: NETWORK", describePushState(s.copy(saved = "io.heckel.ntfy", registration = "failed", registrationError = "NETWORK")))
        assertEquals("Registration failed", describePushState(s.copy(registration = "failed")))
    }

    @Test
    fun relayLine() {
        assertEquals("Relay push support: unknown", describeRelaySupport(emptyList()))
        assertEquals("Relay push support: unknown", describeRelaySupport(listOf(null)))
        assertEquals("Your relay supports push", describeRelaySupport(listOf(true)))
        assertEquals("All your relays support push", describeRelaySupport(listOf(true, true)))
        assertEquals("Relay push support not confirmed yet (needs a registered push app)", describeRelaySupport(listOf(false, null)))
        assertEquals("1 of 2 relays support push", describeRelaySupport(listOf(true, false)))
    }

    @Test
    fun lastPushLine() {
        val day: (Long) -> String = { if (it < 86_400) "1 Jan 1970" else "2 Jan 1970" }
        val hm: (Long) -> String = { "%02d:%02d".format((it / 3600) % 24, (it / 60) % 60) }
        assertEquals("No push received yet", describeLastPush(0, 1000, day, hm))
        assertEquals("Last push: 01:00", describeLastPush(3_600_000, 7_200_000, day, hm))
        assertEquals("Last push: 1 Jan 1970 01:00", describeLastPush(3_600_000, 90_000_000, day, hm))
    }

    @Test
    fun pickingCallsTheBridgeAndToasts() {
        val calls = mutableListOf<String>()
        var status = PushStatus(distributors = listOf(ntfy))
        val bridge = object : PushBridge {
            override fun status() = status
            override fun select(pkg: String) { calls += "select:$pkg"; status = status.copy(saved = pkg, optedOut = false) }
            override fun off() { calls += "off"; status = status.copy(saved = "", optedOut = true) }
        }
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-push-settings-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport? = null
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val model = AppModel(platform, scope)
            model.pushBridge = bridge
            model.refreshPush()
            assertEquals(status, model.pushStatus)
            model.onPickPushApp("io.heckel.ntfy")
            assertEquals("Push app selected", model.toast)
            assertEquals("io.heckel.ntfy", model.pushStatus?.saved)
            model.onPickPushApp(PUSH_OFF_VALUE)
            assertEquals("Push notifications off", model.toast)
            assertTrue(model.pushStatus!!.optedOut)
            assertEquals(listOf("select:io.heckel.ntfy", "off"), calls)
        } finally {
            scope.cancel()
        }
    }
}
