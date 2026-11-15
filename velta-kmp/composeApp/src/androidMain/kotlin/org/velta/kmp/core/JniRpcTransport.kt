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
