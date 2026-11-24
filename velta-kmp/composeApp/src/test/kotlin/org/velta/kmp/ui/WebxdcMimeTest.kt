package org.velta.kmp.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** Android Webxdc asset serving: MIME types for files inside the .xdc. */
class WebxdcMimeTest {

    @Test
    fun knownExtensionsMatchTheirTypes() {
        assertEquals("text/html", mimeFor("index.html"))
        assertEquals("text/html", mimeFor("Index.HTM"))
        assertEquals("application/javascript", mimeFor("js/app.mjs"))
        assertEquals("text/css", mimeFor("style.css"))
        assertEquals("application/json", mimeFor("manifest.json"))
        assertEquals("image/png", mimeFor("icon.png"))
        assertEquals("image/jpeg", mimeFor("photo.JPEG"))
        assertEquals("image/svg+xml", mimeFor("logo.svg"))
        assertEquals("image/webp", mimeFor("pic.webp"))
        assertEquals("application/wasm", mimeFor("app.wasm"))
        assertEquals("audio/ogg", mimeFor("note.opus"))
        assertEquals("video/mp4", mimeFor("clip.mp4"))
        assertEquals("font/woff2", mimeFor("inter.woff2"))
    }

    @Test
    fun unknownOrMissingExtensionIsOctetStream() {
        assertEquals("application/octet-stream", mimeFor("README"))
        assertEquals("application/octet-stream", mimeFor("file.bin"))
        assertEquals("application/octet-stream", mimeFor(""))
    }
}
