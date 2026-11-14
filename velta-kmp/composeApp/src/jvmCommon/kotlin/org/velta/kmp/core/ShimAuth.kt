package org.velta.kmp.core

import java.security.SecureRandom

/** Per-launch secret for the in-process core shim's loopback port (#334). */
object ShimAuth {
    private val random = SecureRandom()

    /** 32 SecureRandom bytes as 64 lowercase hex chars. Memory only. */
    fun newToken(): String {
        val bytes = ByteArray(32).also { random.nextBytes(it) }
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
