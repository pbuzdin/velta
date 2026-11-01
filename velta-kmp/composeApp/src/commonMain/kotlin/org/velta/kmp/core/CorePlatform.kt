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

    /** Human hint shown when [spawnRpcServer] returns null. */
    fun connectHint(): String = "core not available on this platform"
}
