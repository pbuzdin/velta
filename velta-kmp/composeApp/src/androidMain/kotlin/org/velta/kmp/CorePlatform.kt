package org.velta.kmp

import android.content.Context
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcTransport
import java.io.File

/**
 * Android platform: accounts under `filesDir/accounts`. The sidecar spawn is
 * the P1b step (bundle `deltachat-rpc-server` for aarch64 and exec it from
 * `nativeLibraryDir`, the proven Tauri pattern) — until it lands this
 * returns null and the UI shows the connection status (issue #192 P1b).
 */
class AndroidCorePlatform(private val context: Context) : CorePlatform {

    override fun accountsDir(): String =
        File(context.filesDir, "accounts").apply { mkdirs() }.absolutePath

    override fun spawnRpcServer(accountsDir: String): RpcTransport? {
        println("velta-kmp: sidecar spawn not wired yet (P1b) — accounts dir: $accountsDir")
        return null
    }
}
