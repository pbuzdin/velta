package org.velta.kmp

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import org.velta.kmp.ui.markdownAnnotated
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** #321 step 4: the bubble markdown subset (port of app/js/markdown.js). */
class MarkdownTest {

    private val accent = Color(0xFF5AA2E6)
    private val bg = Color(0x0FF4F4F4)
    private val ink = Color(0xFFF2F2F5)

    @Test
    fun boldItalicUnderlineCode() {
        val s = markdownAnnotated("**b** __u__ *i* _j_ `c`", accent, bg, ink)
        assertEquals("b u i j c", s.text)
        val spans = s.spanStyles
        assertEquals(5, spans.size)
        assertEquals(FontWeight.Bold, spans[0].item.fontWeight)
        assertEquals(TextDecoration.Underline, spans[1].item.textDecoration)
        assertEquals(true, spans[2].item.fontStyle == androidx.compose.ui.text.font.FontStyle.Italic)
        assertEquals(true, spans[3].item.fontStyle == androidx.compose.ui.text.font.FontStyle.Italic)
        assertEquals(androidx.compose.ui.text.font.FontFamily.Monospace, spans[4].item.fontFamily)
        assertEquals(bg, spans[4].item.background)
    }

    @Test
    fun linksAndBareUrlsAreAnnotated() {
        val s = markdownAnnotated("see [docs](https://velta.cc/x) and https://a.b/c", accent, bg, ink)
        assertEquals("see docs and https://a.b/c", s.text)
        val urls = s.getUrlAnnotations("URL", "https://velta.cc/x")
        assertTrue(urls.isNotEmpty(), "labeled link annotated")
        assertTrue(s.getUrlAnnotations("URL", "https://a.b/c").isNotEmpty(), "bare url annotated")
    }

    @Test
    fun hashtagsGetAccent() {
        val s = markdownAnnotated("look #Velta now", accent, bg, ink)
        assertEquals("look #Velta now", s.text)
        assertTrue(s.spanStyles.any { it.item.color == accent && s.text.substring(it.start, it.end) == "#Velta" })
    }

    @Test
    fun bulletsAndNumbers() {
        val s = markdownAnnotated("- a\n- b\n1. c", accent, bg, ink)
        assertEquals("•  a\n•  b\n1. c", s.text)
    }

    @Test
    fun bareLinksTakeTheTierRules() {
        val s = markdownAnnotated("see github.com/u/r and main.js and example.com:8080/a", accent, bg, ink)
        assertEquals("see github.com/u/r and main.js and example.com:8080/a", s.text)
        assertTrue(s.getStringAnnotations("URL", 0, s.length).any { it.item == "https://github.com/u/r" }, "tier1 path links")
        assertTrue(s.getStringAnnotations("URL", 0, s.length).any { it.item == "https://example.com:8080/a" }, "port+tail links tier1")
        assertTrue(
            s.getStringAnnotations("URL", 0, s.length).none { it.item.contains("main.js") },
            "file names never link",
        )
    }

    @Test
    fun mentionsResolveMembers() {
        val members = listOf(org.velta.kmp.ui.MentionMember(7, "Pavel", "A1B2"))
        val s = markdownAnnotated("hey @Pavel check @Pavel (A1B2)", accent, bg, ink, members)
        assertEquals("hey @Pavel check @Pavel (A1B2)", s.text)
        val anns = s.getStringAnnotations("MENTION", 0, s.length)
        assertEquals(2, anns.size, "both forms resolve")
        assertTrue(anns.all { it.item == "7" })
    }

    @Test
    fun inviteLinksGetInviteAnnotation() {
        val url = "https://velta.cc/join/#" + "A".repeat(40)
        val s = markdownAnnotated("join: $url", accent, bg, ink)
        assertTrue(s.getStringAnnotations("INVITE", 0, s.length).any { it.item == url }, "invite annotated")
        assertTrue(s.getStringAnnotations("URL", 0, s.length).none { it.item == url }, "not a plain URL")
    }

    @Test
    fun nonHttpsIsNeverALink() {
        val s = markdownAnnotated("ftp://x [x](javascript:alert(1))", accent, bg, ink)
        assertEquals(0, s.getUrlAnnotations("URL", "javascript:alert(1)").size)
        assertEquals("[x](javascript:alert(1))", s.text.substringAfter("ftp://x "))
    }
}

/** AnnotatedString.getUrlAnnotations exists on newer Compose; provide a
 * helper matching the annotation scope when not present. */
private fun androidx.compose.ui.text.AnnotatedString.getUrlAnnotations(
    annotation: String,
    value: String,
): List<androidx.compose.ui.text.AnnotatedString.Range<String>> =
    getStringAnnotations(annotation, 0, length).filter { it.item == value }
