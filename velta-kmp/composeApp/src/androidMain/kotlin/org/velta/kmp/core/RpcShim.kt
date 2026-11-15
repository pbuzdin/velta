package org.velta.kmp.core

/**
 * JNI bridge to `libvelta_rpc_shim.so` (built from `native/rpc-shim/`).
 * One in-process JSON-lines session (#357). [startCore] returns 1, or
 * -1 / -3. There is no port: other apps cannot open the core.
 *
 * Lines arrive on [onNativeLine]. The session ending calls [onNativeExit].
 * A dropped client does not stop the core — [stopCore] does.
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

    /** Ends the session and closes the core's databases. Idempotent; returns 0. */
    external fun stopCore(): Int

    /** One request line. 0 = queued, -1 = no session. */
    external fun sendLine(line: String): Int

    @Volatile
    private var running = false

    /** Bumped when the session ends, so a start that raced the exit does not
     * mark a dead session as running. */
    @Volatile
    private var generation = 0

    private var onLine: ((String) -> Unit)? = null
    private var onExit: (() -> Unit)? = null

    fun setListeners(line: ((String) -> Unit)?, exit: (() -> Unit)?) = synchronized(this) {
        onLine = line
        onExit = exit
    }

    /** Stops the shim and forgets it so the next start is a new session. */
    fun stopCoreOnce(): Int {
        synchronized(this) {
            if (!running) return 0
            running = false
            generation++
            onLine = null
            onExit = null
        }
        return stopCore()
    }

    /**
     * One session per process. A second call while [running] reuses it —
     * another [startCore] would open a second Accounts on the same dir.
     * The DEK never changes within a process, so it is ignored on reuse.
     * Returns 1, or the negative code from the shim.
     */
    fun startCoreOnce(accountsDir: String, dbKey: String): Int {
        val seen = synchronized(this) {
            if (running) return 1
            generation
        }
        val code = startCore(accountsDir, dbKey)
        return synchronized(this) {
            if (code > 0 && generation == seen) {
                running = true
                1
            } else if (generation != seen) {
                -1
            } else {
                code
            }
        }
    }

    @JvmStatic
    fun onNativeLine(line: String) {
        val listener = synchronized(this) { onLine } ?: return
        listener(line)
    }

    @JvmStatic
    fun onNativeExit() {
        val listener = synchronized(this) {
            generation++
            running = false
            onLine = null
            val exit = onExit
            onExit = null
            exit
        }
        listener?.invoke()
    }
}
