package org.velta.kmp.core

import java.io.BufferedReader
import java.net.Socket
import kotlin.concurrent.thread

/**
 * JSON Lines transport over a TCP socket — the Android in-process shim
 * (libvelta_rpc_shim) serves the deltachat JSON-RPC surface on 127.0.0.1.
 */
class SocketRpcTransport(host: String, port: Int) : RpcTransport {

    private val socket = Socket(host, port)
    private val output = socket.getOutputStream()

    override fun start(onLine: (String) -> Unit, onExit: () -> Unit) {
        thread(name = "rpc-socket", isDaemon = true) {
            try {
                val reader = BufferedReader(socket.getInputStream().reader(Charsets.UTF_8))
                while (true) {
                    val line = reader.readLine() ?: break
                    onLine(line)
                }
                onExit()
            } catch (t: Throwable) {
                onExit()
            }
        }
    }

    override fun send(line: String) {
        synchronized(output) {
            output.write((line + "\n").toByteArray(Charsets.UTF_8))
            output.flush()
        }
    }

    override fun close() {
        try {
            socket.close()
        } catch (_: Throwable) {
        }
    }
}
