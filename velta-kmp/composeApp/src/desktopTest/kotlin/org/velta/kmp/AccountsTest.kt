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

/** P4 account switcher: list, switch (core persists the choice), reload. */
class AccountsTest {

    @Test
    fun switchAccountSelectsAndReloads() = runBlocking {
        val transport = ScriptedRpcTransport(
            mapOf(
                "get_system_info" to """{"deltachat_core_version":"v2.66.0"}""",
                "get_all_account_ids" to "[1]",
                "get_selected_account_id" to "1",
                // Static fixture: serves resume's accountInfo(1); the switch's
                // accountInfo(2) decodes the same entry (fixture limitation).
                "get_account_info" to """{"id":1,"addr":"a@example.org","isConfigured":true}""",
                "get_all_accounts" to
                    """[{"id":1,"addr":"a@example.org","isConfigured":true},{"id":2,"addr":"b@example.org","isConfigured":true}]""",
                "select_account" to "null",
                "start_io_for_all_accounts" to "null",
                "get_chatlist_entries" to "[]",
            ),
        )
        val platform = object : CorePlatform {
            override fun accountsDir(): String = "/tmp/velta-kmp-accounts-test"
            override fun spawnRpcServer(accountsDir: String): RpcTransport = transport
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = AppModel(platform, scope)
        try {
            model.connect()
            withTimeout(10_000) {
                while (model.screen != AppModel.Screen.ChatList) yield()
            }
            model.openAccounts()
            withTimeout(10_000) {
                while (model.accounts.size < 2) yield()
            }

            assertEquals(1L, model.accountId, "resume landed on the selected account 1")
            model.switchAccount(2)

            withTimeout(10_000) {
                while (model.accountId != 2L) yield()
            }
            withTimeout(10_000) {
                while (model.screen != AppModel.Screen.ChatList) yield()
            }
            // select_account must have been called with the chosen id, and a
            // fresh chatlist load must follow it.
            withTimeout(10_000) {
                while (true) {
                    val idx = transport.requests.indexOfFirst { "\"select_account\"" in it && "[2]" in it }
                    if (idx >= 0 && transport.requests.drop(idx + 1).any { "\"get_chatlist_entries\"" in it }) break
                    yield()
                }
            }
            val selectLine = transport.requests.first { "\"select_account\"" in it && "[2]" in it }
            assertEquals(true, selectLine.contains("[2]"), "select params: $selectLine")
        } finally {
            scope.cancel()
        }
    }
}
