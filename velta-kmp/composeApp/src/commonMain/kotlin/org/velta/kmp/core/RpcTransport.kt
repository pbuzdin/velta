package org.velta.kmp.core

/**
 * Byte-transport for the JSON Lines RPC stream of `deltachat-rpc-server`.
 *
 * The server speaks one JSON value per line on stdout (responses and
 * server-pushed calls), reads requests from stdin line by line and logs to
 * stderr only — see `core/deltachat-rpc-server/src/main.rs`.
 */
interface RpcTransport : AutoCloseable {
    /** Start feeding stdout lines (and process exit) to the given callbacks. */
    fun start(onLine: (String) -> Unit, onExit: () -> Unit)

    /** Write one request line to stdin. Implementations must serialize writers. */
    fun send(line: String)
}
