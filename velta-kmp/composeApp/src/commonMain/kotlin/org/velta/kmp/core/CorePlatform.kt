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

    /**
     * Tear the core down (shim: stop accept loop, close databases; sidecar
     * platforms: nothing — the process ends with its transport). The next
     * [spawnRpcServer] must start fresh.
     */
    fun stopRpcServer() {}

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

    /** Android can wrap the database key under a PIN. Desktop has no key to wrap. */
    fun appPinSupported(): Boolean = false

    /** A `dbkey.pin.wrap` is the key root right now. */
    fun pinLockOn(): Boolean = false

    /**
     * Verify [pin] and return the DEK. Argon2id is slow; call off the main thread.
     */
    fun unlockWithPin(pin: String): PinUnlock = PinUnlock.Unsupported

    /**
     * Wrap the running DEK under [newPin]. [oldPin] is required when a PIN
     * wrap already exists. "ok", or pin too short / retry:N / corrupt /
     * no-key / current-pin-required / wrap verify failed / unsupported.
     */
    fun setAppPin(oldPin: String?, newPin: String): String = "unsupported"

    /** "ok", or retry:N / corrupt / keychain-unavailable / unsupported. */
    fun clearAppPin(pin: String): String = "unsupported"

    /** Forget the in-memory DEK. Lock paths call this so a locked process holds no key. */
    fun dropDek() {}

    /**
     * App-level settings storage (#321 step 5). The web keeps these in
     * localStorage (dw-theme, velta-amoled, velta-accent, velta-lang); KMP
     * maps the same keys onto each platform's key-value store. A null
     * [value] removes the key (the web "unset = default" convention).
     */
    /** App version name for the welcome splash version line. */
    fun appVersion(): String = "dev"

    fun pref(key: String): String? = null
    fun setPref(key: String, value: String?) {}

    /**
     * Apply the user-chosen launcher icon. Android enables exactly one
     * activity-alias (`DONT_KILL_APP`); other platforms no-op. [choice] is
     * [org.velta.kmp.ui.AppIconChoice.prefValue] (`default` / `badge` / `classic`).
     */
    fun applyAppIcon(choice: String) {}

    /** Android shim has the Loop engine. Desktop's stock core does not. */
    fun loopAvailable(): Boolean = false

    /**
     * Start the LAN engine rooted at [accountsDir]. Null when this platform
     * cannot. The caller only invokes this while `velta-p2p` is on.
     */
    fun openLoop(accountsDir: String): RpcTransport? = null

    /** Stop the engine and release its socket. Idempotent. */
    fun closeLoop() {}
}
