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
import kotlin.test.assertTrue

/**
 * P4 push plumbing: a UnifiedPush endpoint registers through the shim-only
 * `velta_set_push_device_token` method, and a push message wakes a fetch
 * (start_io + background_fetch). The token is the webpush serialization the
 * Tauri shell uses; the core treats it as opaque.
 */
class PushTest {

    private fun testScope() = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Test
    fun endpointRegistersThroughShimMethod() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                "get_account_info" to """{"id":1,"addr":"a@example.org","isConfigured":true}""",
                "get_chatlist_entries" to "[]",
                "velta_set_push_device_token" to "null",
            ),
        )
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-push-endpoint-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = testScope()
        val model = AppModel(platform, scope)
        try {
            model.connect()
            withTimeout(10_000) {
                while (model.screen != AppModel.Screen.ChatList) yield()
            }

            val token = "webpush:https://ntfy.example/topic|PUBKEY|AUTH"
            model.onPushEndpoint(token)
            withTimeout(10_000) {
                while (transport.requests.none { "\"velta_set_push_device_token\"" in it }) yield()
            }

            val line = transport.requests.first { "\"velta_set_push_device_token\"" in it }
            assertTrue(line.contains(token), "token must ride the shim method: $line")
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun pushWakeupFetches() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                "get_account_info" to """{"id":1,"addr":"a@example.org","isConfigured":true}""",
                "get_chatlist_entries" to "[]",
                "start_io_for_all_accounts" to "null",
                "background_fetch" to "null",
            ),
        )
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-push-wakeup-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = testScope()
        val model = AppModel(platform, scope)
        try {
            model.connect()
            withTimeout(10_000) {
                while (model.screen != AppModel.Screen.ChatList) yield()
            }

            model.onPushWakeup()
            withTimeout(10_000) {
                while (transport.requests.none { "\"background_fetch\"" in it }) yield()
            }

            val fetchIdx = transport.requests.indexOfFirst { "\"background_fetch\"" in it }
            assertTrue(
                transport.requests.drop(fetchIdx + 1).none { "\"background_fetch\"" in it },
                "exactly one fetch per wakeup",
            )
            val ioIdx = transport.requests.indexOfFirst { "\"start_io_for_all_accounts\"" in it }
            assertTrue(ioIdx in 0 until fetchIdx, "io starts before the fetch")
        } finally {
            scope.cancel()
        }
    }
}
