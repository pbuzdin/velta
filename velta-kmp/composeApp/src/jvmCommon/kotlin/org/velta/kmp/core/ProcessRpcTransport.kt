package org.velta.kmp.core

import kotlin.concurrent.thread

/** stdio transport over a spawned `deltachat-rpc-server` process (JVM targets). */
class ProcessRpcTransport(private val process: Process) : RpcTransport {

    private val stdin = process.outputStream

    override fun start(onLine: (String) -> Unit, onExit: () -> Unit) {
        thread(name = "rpc-stdout", isDaemon = true) {
            try {
                val reader = process.inputStream.bufferedReader()
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
        synchronized(stdin) {
            stdin.write((line + "\n").toByteArray(Charsets.UTF_8))
            stdin.flush()
        }
    }

    override fun close() {
        try {
            stdin.close()
        } catch (_: Throwable) {
        }
        process.destroy()
    }
}
