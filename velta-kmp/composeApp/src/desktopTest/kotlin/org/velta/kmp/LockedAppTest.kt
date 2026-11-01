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
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * P4 app lock (phase 4 port): an app-locked platform blocks the core
 * entirely until the unlock path hands over the DEK; then it starts with
 * THAT key (spawnRpcServerWithKey, not the store path).
 */
class LockedAppTest {

    private fun testScope() = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Test
    fun lockedPlatformBlocksCoreUntilUnlocked() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                "get_account_info" to """{"id":1,"addr":"a@example.org","isConfigured":true}""",
                "get_chatlist_entries" to "[]",
            ),
        )
        var withKeyCalls = 0
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-locked-test"
            override fun isAppLocked(): Boolean = true
            override fun isAppLockOn(): Boolean = true
            override fun spawnRpcServer(accountsDir: String): RpcTransport? {
                throw AssertionError("a locked app must not spawn the plain path")
            }

            override fun spawnRpcServerWithKey(accountsDir: String, dbKey: String): RpcTransport {
                withKeyCalls++
                assertEquals("deadbeef", dbKey)
                return transport
            }
        }
        val scope = testScope()
        val model = AppModel(platform, scope)
        try {
            model.connect()
            withTimeout(5_000) {
                while (!model.locked) yield()
            }
            assertEquals(false, model.connected, "locked = no core, no plaintext")
            assertEquals("locked", model.status)
            assertTrue(transport.requests.isEmpty(), "no RPC may run while locked")

            // The unlock flow: prompt success → DEK → connect with the key.
            model.onAppUnlocked("deadbeef")
            withTimeout(10_000) {
                while (model.screen != AppModel.Screen.ChatList) yield()
            }
            assertEquals(false, model.locked)
            assertEquals(1, withKeyCalls, "exactly one keyed spawn")
            assertEquals("a@example.org", model.accountAddr)
        } finally {
            scope.cancel()
        }
    }
}
