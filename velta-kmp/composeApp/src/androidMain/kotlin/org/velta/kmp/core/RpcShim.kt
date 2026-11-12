package org.velta.kmp.core

/**
 * JNI bridge to `libvelta_rpc_shim.so` (built from `native/rpc-shim/`).
 * The shim starts the deltachat core in-process and serves JSON-RPC on a
 * loopback port; [startCore] returns the port (or -1/-2/-3 on failure).
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
    external fun startCore(accountsDir: String, dbKey: String): Int

    /** Shuts the accept loop + live sessions down and closes the core's
     * databases. Idempotent; always returns 0. */
    external fun stopCore(): Int

    /** Port of the shim started in this process; 0 = none yet. */
    @Volatile
    private var runningPort = 0

    /** [startCoreOnce]'s counterpart: stops the shim and forgets the port so
     * the next start spawns fresh. Safe to call when nothing is running. */
    fun stopCoreOnce(): Int = synchronized(this) {
        val result = if (runningPort > 0) stopCore() else 0
        runningPort = 0
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
    fun startCoreOnce(accountsDir: String, dbKey: String): Int = synchronized(this) {
        if (runningPort > 0) return runningPort
        runningPort = startCore(accountsDir, dbKey)
        runningPort
    }
}
