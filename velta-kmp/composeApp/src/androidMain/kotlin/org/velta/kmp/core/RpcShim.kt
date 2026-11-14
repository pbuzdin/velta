package org.velta.kmp.core

/**
 * JNI bridge to `libvelta_rpc_shim.so` (built from `native/rpc-shim/`).
 * The shim starts the deltachat core in-process and serves JSON-RPC on a
 * loopback port; [startCore] returns the port (or -1/-2/-3/-4 on failure).
 *
 * Loopback is reachable by every app on the device, so each start carries a
 * per-launch auth token (#334): 32 SecureRandom bytes, hex, held only in
 * this object's memory. The shim drops any connection whose first line is
 * not that token before it reads a single RPC line.
 *
 * The .so files are NOT committed — build them per AGENTS/README and drop
 * them into `jniLibs/<abi>/` (mirrors the Tauri app's `binaries/` rule).
 */
object RpcShim {
    val available: Boolean by lazy {
        try {
            System.loadLibrary("velta_rpc_shim")
            true
        } catch (t: Throwable) {
            println("velta-kmp: libvelta_rpc_shim.so not available: $t")
            false
        }
    }

    /**
     * @param dbKey 64-hex database-encryption DEK (VeltaKeystore), or "" to
     * run keyless (core patch #20 reads VELTA_DB_KEY; empty = upstream).
     */
    external fun startCore(accountsDir: String, dbKey: String, authToken: String): Int

    /** Shuts the accept loop + live sessions down and closes the core's
     * databases. Idempotent; always returns 0. */
    external fun stopCore(): Int

    /** Where the running shim listens and the secret it expects first. */
    class Endpoint(val port: Int, val authToken: String)

    /** Port of the shim started in this process; 0 = none yet. */
    @Volatile
    private var runningPort = 0

    /** The running shim's auth token — memory only, never persisted/logged. */
    @Volatile
    private var runningToken = ""


    /** [startCoreOnce]'s counterpart: stops the shim and forgets the port so
     * the next start spawns fresh. Safe to call when nothing is running. */
    fun stopCoreOnce(): Int = synchronized(this) {
        val result = if (runningPort > 0) stopCore() else 0
        runningPort = 0
        runningToken = ""
        result
    }

    /**
     * One shim per process: each JNI startCore call spawns a NEW Accounts
     * manager + core on the same accounts dir, so a second call (retry after
     * a dropped connection) would run two cores on one database. The shim is
     * a long-lived accept-loop server — a dropped client socket does NOT end
     * it — so the first port stays valid for reconnects. The DEK never
     * changes within a process lifetime, so it is ignored on reuse.
     */
    fun startCoreOnce(accountsDir: String, dbKey: String): Endpoint = synchronized(this) {
        if (runningPort > 0) return Endpoint(runningPort, runningToken)
        val token = ShimAuth.newToken()
        val port = startCore(accountsDir, dbKey, token)
        if (port > 0) {
            runningPort = port
            runningToken = token
        }
        Endpoint(port, token)
    }
}
