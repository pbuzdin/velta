package org.velta.kmp.core

/**
 * Platform seam: where the accounts directory lives and how to start the
 * deltachat JSON-RPC core on this platform.
 *
 * Desktop spawns the sidecar binary; Android loads the in-process Rust shim
 * (`native/rpc-shim`) — both speak JSON Lines, so the client never cares.
 */
interface CorePlatform {
    /** Default accounts directory for this platform (created on demand). */
    fun accountsDir(): String

    /**
     * Start the core rooted at [accountsDir]. Returns null when nothing
     * could be started — the UI surfaces [connectHint] then.
     */
    fun spawnRpcServer(accountsDir: String): RpcTransport?

    /**
     * Start the core with an explicit database key (the app-lock unlock
     * path: the DEK comes from the bio wrap after a successful prompt).
     * Default: ignore the key and spawn normally.
     */
    fun spawnRpcServerWithKey(accountsDir: String, dbKey: String): RpcTransport? =
        spawnRpcServer(accountsDir)

    /** Human hint shown when [spawnRpcServer] returns null. */
    fun connectHint(): String = "core not available on this platform"

    /** App lock (phase 4 port): is the core blocked pending user unlock? */
    fun isAppLocked(): Boolean = false

    /** Is the app-lock setting enabled (regardless of the current state)? */
    fun isAppLockOn(): Boolean = false

    /**
     * Enable the app lock: wrap the current DEK into the auth-window wrap
     * and flip the flag. MUST be called inside the auth window a successful
     * prompt just opened. Returns false when the platform cannot (desktop).
     */
    fun enableAppLock(): Boolean = false

    /** Disable: DEK back into the plain wrap, bio wrap dropped. */
    fun disableAppLock(): Boolean = false
}
