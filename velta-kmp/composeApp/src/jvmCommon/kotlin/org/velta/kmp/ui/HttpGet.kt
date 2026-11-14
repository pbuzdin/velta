package org.velta.kmp.ui

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URI

actual suspend fun httpGetText(url: String): Pair<Int, String> = withContext(Dispatchers.IO) {
    val conn = URI(url).toURL().openConnection() as HttpURLConnection
    try {
        conn.connectTimeout = 15_000
        conn.readTimeout = 30_000
        conn.useCaches = false
        conn.requestMethod = "GET"
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
        code to body
    } finally {
        conn.disconnect()
    }
}
