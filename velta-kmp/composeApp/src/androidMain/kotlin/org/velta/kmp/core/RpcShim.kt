package org.velta.kmp.core

/**
 * JNI bridge to `libvelta_rpc_shim.so` (built from `native/rpc-shim/`).
 * The shim starts the deltachat core in-process and serves JSON-RPC on a
 * loopback port; [startCore] returns the port (or -1 on failure).
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

    external fun startCore(accountsDir: String): Int
}
