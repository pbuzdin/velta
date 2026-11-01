package org.velta.kmp

import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.ProcessRpcTransport
import org.velta.kmp.core.RpcTransport
import java.io.File

/**
 * Desktop platform: accounts under `~/.velta-kmp/accounts`; the sidecar binary
 * is resolved from `VELTA_KMP_RPC_SERVER`, then a `bin/` sibling, then PATH.
 */
class DesktopCorePlatform : CorePlatform {

    override fun accountsDir(): String =
        File(System.getProperty("user.home"), ".velta-kmp/accounts")
            .apply { mkdirs() }
            .absolutePath

    override fun spawnRpcServer(accountsDir: String): RpcTransport? {
        val isWindows = System.getProperty("os.name").lowercase().contains("windows")
        val exe = if (isWindows) "deltachat-rpc-server.exe" else "deltachat-rpc-server"
        val candidates = listOfNotNull(
            System.getenv("VELTA_KMP_RPC_SERVER")?.let { File(it) },
            File("bin", exe),
        ).filter { it.isFile }
        val command = candidates.firstOrNull()?.absolutePath ?: exe

        return try {
            val process = ProcessBuilder(command)
                .apply {
                    environment()["DC_ACCOUNTS_PATH"] = accountsDir
                    redirectErrorStream(false)
                }
                .start()
            ProcessRpcTransport(process)
        } catch (t: Throwable) {
            println("velta-kmp: failed to spawn '$command': $t")
            null
        }
    }

    override fun connectHint(): String =
        "no deltachat-rpc-server binary found (set VELTA_KMP_RPC_SERVER)"
}
