package org.velta.kmp

import android.content.Context
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcShim
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.core.SocketRpcTransport
import java.io.File

/**
 * Android platform: accounts under `filesDir/accounts`; the core runs
 * IN-PROCESS via the Rust cdylib shim (native/rpc-shim), which serves the
 * deltachat JSON-RPC surface on a loopback port — same architecture as the
 * Tauri Android shell, no exec'd sidecar (issue #192 P1b).
 */
class AndroidCorePlatform(private val context: Context) : CorePlatform {

    override fun accountsDir(): String =
        File(context.filesDir, "accounts").apply { mkdirs() }.absolutePath

    override fun spawnRpcServer(accountsDir: String): RpcTransport? {
        if (!RpcShim.available) {
            println("velta-kmp: rpc shim not packaged — build native/rpc-shim for this ABI (see README)")
            return null
        }
        return try {
            val port = RpcShim.startCore(accountsDir)
            if (port <= 0) {
                println("velta-kmp: shim failed to start the core (port=$port)")
                null
            } else {
                SocketRpcTransport("127.0.0.1", port)
            }
        } catch (t: Throwable) {
            println("velta-kmp: shim start threw: $t")
            null
        }
    }

    override fun connectHint(): String =
        "core shim missing — build native/rpc-shim (README) and copy into jniLibs"
}
