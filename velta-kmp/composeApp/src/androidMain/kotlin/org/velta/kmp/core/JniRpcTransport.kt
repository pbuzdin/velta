package org.velta.kmp.core

/**
 * JSON Lines to the in-process shim (#357). [close] detaches this client
 * and leaves the core running; [RpcShim.stopCore] is the session end.
 */
class JniRpcTransport : RpcTransport {

    override fun start(onLine: (String) -> Unit, onExit: () -> Unit) {
        RpcShim.setListeners(onLine, onExit)
    }

    override fun send(line: String) {
        val code = RpcShim.sendLine(line)
        if (code != 0) throw IllegalStateException("rpc shim rejected the line ($code)")
    }

    override fun close() {
        RpcShim.setListeners(null, null)
    }
}

/** Loop JSON-lines. [close] detaches this client; [RpcShim.stopLoop] stops the engine. */
class JniLoopTransport : RpcTransport {
    override fun start(onLine: (String) -> Unit, onExit: () -> Unit) {
        RpcShim.setLoopListeners(onLine, onExit)
    }

    override fun send(line: String) {
        val code = RpcShim.sendLoopLine(line)
        if (code != 0) throw IllegalStateException("loop shim rejected the line ($code)")
    }

    override fun close() {
        RpcShim.setLoopListeners(null, null)
    }
}
