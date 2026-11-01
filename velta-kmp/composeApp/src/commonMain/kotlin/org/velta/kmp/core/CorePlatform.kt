package org.velta.kmp.core

/**
 * Platform seam: where the accounts directory lives and how to spawn the
 * `deltachat-rpc-server` binary on this platform.
 *
 * Desktop spawns the sidecar binary (already built for the Tauri app);
 * Android reuses the same exec pattern today — the in-process shim that
 * replaces it is the P1b/P4 endgame (issue #192).
 */
interface CorePlatform {
    /** Default accounts directory for this platform (created on demand). */
    fun accountsDir(): String

    /**
     * Spawn `deltachat-rpc-server` with its accounts directory rooted at
     * [accountsDir]. Returns null when no binary could be located — the UI
     * surfaces that as a connection error.
     */
    fun spawnRpcServer(accountsDir: String): RpcTransport?
}
