package org.velta.kmp

import org.velta.kmp.ui.PROXY_LINK_MAX
import org.velta.kmp.ui.ProxyLink
import org.velta.kmp.ui.ProxyLinkError
import org.velta.kmp.ui.base32Decode
import org.velta.kmp.ui.base32Encode
import org.velta.kmp.ui.buildProxyLink
import org.velta.kmp.ui.parseProxyLink
import org.velta.kmp.ui.socksUrl
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #334 step 11: proxy links match app/js/proxy.js; the URL matches proxy_store.rs. */
class ProxyRulesTest {
    private fun base(extra: String = "") = "velta://proxy?v=1&h=proxy.example.org&p=1080$extra"

    @Test
    fun parsesMinimalAndFull() {
        assertEquals(ProxyLink(1, "proxy.example.org", 1080, "", "", ""), parseProxyLink(base()))
        val full = parseProxyLink(base("&u=me&w=p%40ss%3Aword&n=Office%20VPN"))
        assertEquals("me", full.user)
        assertEquals("p@ss:word", full.pass)
        assertEquals("Office VPN", full.label)
    }

    @Test
    fun normalizesHost() {
        assertEquals("proxy.example.org", parseProxyLink("velta://proxy?h=Proxy.Example.ORG.&p=1080").host)
        assertEquals(1080, parseProxyLink("VELTA://PROXY/?h=proxy.example.org&p=1080").port)
        assertEquals("My proxy", parseProxyLink(base("&n=My+proxy")).label)
        assertEquals("2001:db8::1", parseProxyLink("velta://proxy?h=%5B2001:db8::1%5D&p=1080").host)
    }

    @Test
    fun rejectsMalformed() {
        val cases = listOf(
            "" to "Empty link",
            "velta://chat?chat=1" to "Not a velta://proxy link",
            "velta://proxy" to "The proxy server address is not valid",
            "velta://proxy?h=proxy.example.org" to "The port is not valid",
            "velta://proxy?h=10.0.0.999&p=1080" to "The proxy server address is not valid",
            "velta://proxy?h=proxy.example.org&p=1080&x=1" to "Unknown parameter: {name}",
            "velta://proxy?v=9&h=a.org&p=1080" to "Unsupported link version {version}: update Velta",
            "velta://proxy?h=a.org&p=1080&w=secret" to "A password without a username is not valid",
            "velta://proxy?" + "h=a.org&p=1080&n=" + "x".repeat(PROXY_LINK_MAX) to "The link is too long",
        )
        for ((link, key) in cases) {
            assertEquals(key, assertFailsWith<ProxyLinkError> { parseProxyLink(link) }.key, link)
        }
    }

    @Test
    fun base32Rfc4648() {
        val vectors = listOf(
            "" to "", "f" to "MY", "fo" to "MZXQ", "foo" to "MZXW6",
            "foob" to "MZXW6YQ", "fooba" to "MZXW6YTB", "foobar" to "MZXW6YTBOI",
        )
        for ((ascii, enc) in vectors) {
            assertEquals(enc, base32Encode(ascii.encodeToByteArray()))
            assertEquals(ascii, base32Decode(enc)!!.decodeToString())
        }
        assertEquals("foobar", base32Decode("mzxw6ytboi")!!.decodeToString())
        assertNull(base32Decode("M"))
        assertNull(base32Decode("MZ"))
    }

    @Test
    fun v2RoundTripAndSocksUrl() {
        val cfg = ProxyLink(2, "proxy.example.org", 1080, "me", "p@ss:word", "Офис ✓")
        val link = buildProxyLink(cfg.host, cfg.port, cfg.user, cfg.pass, cfg.label)
        assertTrue(link.startsWith("velta://proxy/2/PROXY.EXAMPLE.ORG/1080/U/"))
        assertEquals(cfg, parseProxyLink(link))
        assertEquals("socks5://proxy.example.org:1080", socksUrl(parseProxyLink(base())))
        assertEquals("socks5://me:p%40ss%3Aword@proxy.example.org:1080", socksUrl(parseProxyLink(base("&u=me&w=p%40ss%3Aword"))))
        assertEquals("socks5://[2001:db8::1]:1080", socksUrl(parseProxyLink("velta://proxy?h=%5B2001:db8::1%5D&p=1080")))
    }
}
