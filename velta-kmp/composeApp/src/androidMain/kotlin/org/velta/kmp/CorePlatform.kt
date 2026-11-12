package org.velta.kmp

import android.content.Context
import org.velta.kmp.core.CorePlatform
import org.velta.kmp.core.RpcShim
import org.velta.kmp.core.RpcTransport
import org.velta.kmp.core.SocketRpcTransport
import org.velta.kmp.core.VeltaForegroundService
import org.velta.kmp.core.VeltaKeystore
import org.velta.kmp.core.VeltaLock
import java.io.File
import kotlin.concurrent.thread

/**
 * Android platform: accounts under `filesDir/accounts`; the core runs
 * IN-PROCESS via the Rust cdylib shim (native/rpc-shim), which serves the
 * deltachat JSON-RPC surface on a loopback port — same architecture as the
 * Tauri Android shell, no exec'd sidecar (issue #192 P1b).
 */
class AndroidCorePlatform(private val context: Context) : CorePlatform {

    /** Port of the one shim runtime. A second startCore would open the db again. */
    private var livePort: Int = 0

    override fun accountsDir(): String =
        File(context.filesDir, "accounts").apply { mkdirs() }.absolutePath

    override fun spawnRpcServer(accountsDir: String): RpcTransport? {
        // Database encryption at rest (#178 port): the DEK comes from the
        // Keystore wrap; null → "" runs keyless, which leaves
        // already-encrypted databases locked instead of recreating them.
        val dbKey = VeltaKeystore.getOrCreateDek(context) ?: ""
        return openCore(accountsDir, dbKey)
    }

    override fun connectHint(): String =
        "core shim missing — build native/rpc-shim (README) and copy into jniLibs"

    override fun isAppLocked(): Boolean =
        VeltaLock.on(context) && VeltaLock.bioFile(context).exists()

    override fun isAppLockOn(): Boolean = VeltaLock.on(context)

    /** Unlock path: the DEK comes from the auth-window unwrap, not the store. */
    override fun spawnRpcServerWithKey(accountsDir: String, dbKey: String): RpcTransport? =
        openCore(accountsDir, dbKey)

    private fun openCore(accountsDir: String, dbKey: String): RpcTransport? {
        if (!RpcShim.available) {
            println("velta-kmp: rpc shim not packaged — build native/rpc-shim for this ABI (see README)")
            return null
        }
        return try {
            val port = livePort.takeIf { it > 0 } ?: RpcShim.startCore(accountsDir, dbKey).also {
                if (it > 0) livePort = it
            }
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

    override fun killProcessToRecover(): Boolean = true

    override fun abandonProcess() {
        // startForeground has to land or the system will not sticky-restart us.
        VeltaForegroundService.start(context)
        thread(isDaemon = true, name = "velta-core-restart") {
            Thread.sleep(300)
            android.os.Process.killProcess(android.os.Process.myPid())
        }
    }

    /** MUST be called inside the auth window a successful prompt just opened. */
    override fun enableAppLock(): Boolean {
        val dek = VeltaKeystore.getOrCreateDek(context) ?: return false
        return VeltaKeystore.enableAppLock(context, dek)
    }

    /** The DEK for the plain wrap comes from the bio wrap's auth window. */
    override fun disableAppLock(): Boolean {
        val dek = VeltaKeystore.unlockDek(context) ?: return false
        return VeltaKeystore.disableAppLock(context, dek)
    }
}
