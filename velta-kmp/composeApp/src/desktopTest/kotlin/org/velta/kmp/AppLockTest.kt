package org.velta.kmp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.ui.AppModel
import org.velta.kmp.ui.LockPolicy
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #334 step 4: auto-lock, prompt/key policy, user-visible lock errors. */
class AppLockTest {

    private val script = mapOf(
        "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
        "get_all_account_ids" to "[1]",
        "get_selected_account_id" to "1",
        "get_account_info" to """{"id":1,"addr":"a@example.org","isConfigured":true}""",
        "select_account" to "null",
        "start_io_for_all_accounts" to "null",
        "get_chatlist_entries" to "[]",
    )

    private class Fake(val lockOn: Boolean, private val transports: () -> RpcTransport) : CorePlatform {
        val prefs = HashMap<String, String>()
        var stops = 0
        var keyedSpawns = 0
        var enableOk = true
        override fun accountsDir() = "/tmp/velta-kmp-applock-test"
        override fun isAppLockOn() = lockOn
        override fun isAppLocked() = false // DEK in hand at the first start
        override fun spawnRpcServer(accountsDir: String) = transports()
        override fun spawnRpcServerWithKey(accountsDir: String, dbKey: String): RpcTransport {
            keyedSpawns++
            return transports()
        }
        override fun stopRpcServer() { stops++ }
        override fun enableAppLock() = enableOk
        override fun pref(key: String) = prefs[key]
        override fun setPref(key: String, value: String?) {
            if (value == null) prefs.remove(key) else prefs[key] = value
        }
    }

    private fun <T> withModel(platform: Fake, block: suspend (AppModel) -> T): T = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val model = AppModel(platform, scope)
            model.connect()
            withTimeout(10_000) { while (model.screen != AppModel.Screen.ChatList || !model.connected) yield() }
            block(model)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun authenticatorsNeverAcceptLessThanTheKey() {
        // The key takes STRONG or the device credential; the prompt must not
        // offer weak biometrics on any API level.
        for (sdk in 26..36) {
            val a = LockPolicy.authenticators(sdk)
            assertTrue(a.strongBiometric, "sdk $sdk")
            assertEquals(!a.deviceCredential, a.needsNegativeButton, "sdk $sdk")
        }
        assertTrue(LockPolicy.authenticators(35).deviceCredential)
        assertFalse(LockPolicy.authenticators(29).deviceCredential, "API 28-29 reject STRONG|CREDENTIAL")
        assertFalse(LockPolicy.authenticators(28).deviceCredential)
        assertTrue(LockPolicy.authenticators(27).deviceCredential)
    }

    @Test
    fun shouldAutoLockEdges() {
        assertFalse(LockPolicy.shouldAutoLock(null, 10_000_000, 1))
        assertFalse(LockPolicy.shouldAutoLock(0, 10_000_000, 0), "0 = off")
        assertFalse(LockPolicy.shouldAutoLock(0, 59_999, 1))
        assertTrue(LockPolicy.shouldAutoLock(0, 60_000, 1))
        assertEquals(listOf(0, 1, 5, 15), LockPolicy.AUTOLOCK_CHOICES, "stable's choices")
    }

    @Test
    fun autoLocksAfterTheTimeoutAndUnlocksWithTheKey() {
        val platform = Fake(lockOn = true) { ScriptedRpcTransport(script) }
        withModel(platform) { model ->
            var now = 1_000_000L
            model.clockMillis = { now }
            assertEquals(0, model.autoLockMins, "default off, like stable")
            model.onSetAutoLock(5)
            assertEquals("5", platform.prefs["velta-autolock-mins"], "stable's web key")

            model.onAppForeground(false)
            now += 4 * 60_000L
            model.onAppForeground(true)
            assertFalse(model.locked, "under the limit")

            model.onAppForeground(false)
            now += 5 * 60_000L
            model.onAppForeground(true)
            assertTrue(model.locked)
            withTimeout(5_000) { while (platform.stops == 0 || model.connected || model.status != "locked") yield() }
            assertTrue(model.chats.isEmpty())

            model.onAppUnlocked("deadbeef")
            withTimeout(10_000) { while (!model.connected || model.screen != AppModel.Screen.ChatList) yield() }
            assertFalse(model.locked)
            assertEquals(1, platform.keyedSpawns)
        }
    }

    @Test
    fun noAutoLockWhenOffOrLockDisabled() {
        val off = Fake(lockOn = true) { ScriptedRpcTransport(script) }
        withModel(off) { model ->
            var now = 0L
            model.clockMillis = { now }
            model.onAppForeground(false)
            now += 60 * 60_000L
            model.onAppForeground(true)
            assertFalse(model.locked, "auto-lock off by default")
        }
        val noLock = Fake(lockOn = false) { ScriptedRpcTransport(script) }
        noLock.prefs["velta-autolock-mins"] = "1"
        withModel(noLock) { model ->
            var now = 0L
            model.clockMillis = { now }
            assertEquals(1, model.autoLockMins)
            model.onAppForeground(false)
            now += 60 * 60_000L
            model.onAppForeground(true)
            assertFalse(model.locked, "nothing to lock without the app lock")
            assertEquals(0, noLock.stops)
        }
    }

    @Test
    fun enableFailureIsShownToTheUser() {
        val platform = Fake(lockOn = false) { ScriptedRpcTransport(script) }
        platform.enableOk = false
        withModel(platform) { model ->
            model.onAppLockEnabled()
            assertFalse(model.appLockOn)
            assertNotNull(model.lockError)
            model.onLockError(null)
            assertNull(model.lockError)
        }
    }
}
