package org.velta.kmp

import org.velta.kmp.core.MessageObject
import org.velta.kmp.ui.DOWNLOAD_LIMIT_OPTIONS
import org.velta.kmp.ui.L
import org.velta.kmp.ui.MEDIA_QUALITY_OPTIONS
import org.velta.kmp.ui.SheetAction
import org.velta.kmp.ui.SheetContext
import org.velta.kmp.ui.VeltaThemeChoice
import org.velta.kmp.ui.choiceSummary
import org.velta.kmp.ui.coversAttachment
import org.velta.kmp.ui.downloadCardName
import org.velta.kmp.ui.downloadCardSub
import org.velta.kmp.ui.downloadLimitToast
import org.velta.kmp.ui.hiddenKindLabel
import org.velta.kmp.ui.mediaQualityToast
import org.velta.kmp.ui.messageSheetActions
import org.velta.kmp.ui.needsDownloadCard
import org.velta.kmp.ui.revealActionLabel
import org.velta.kmp.ui.revealKey
import org.velta.kmp.ui.savedDownloadLimit
import org.velta.kmp.ui.savedMediaQuality
import org.velta.kmp.ui.textOnlyLabel
import org.velta.kmp.ui.textOnlyModeOf
import org.velta.kmp.ui.textOnlyStored
import org.velta.kmp.ui.themeLabel
import org.velta.kmp.ui.toggleSummary
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MediaGateRulesTest {
    private fun photo(from: Long = 10, ds: String? = "Done") =
        MessageObject(id = 7, fromId = from, viewType = "Image", file = "/blobs/a.jpg", fileName = "a.jpg", fileBytes = 2048, downloadState = ds)

    @Test fun downloadLimitOptionsAndMigration() {
        assertEquals(listOf("0", "1048576", "5242880", "26214400"), DOWNLOAD_LIMIT_OPTIONS.map { it.first })
        assertEquals("0" to false, savedDownloadLimit(null))
        assertEquals("1048576" to true, savedDownloadLimit("655360"))
        assertEquals("5242880" to false, savedDownloadLimit("5242880"))
        assertEquals("Auto-download limit: none", downloadLimitToast("0"))
        assertEquals("Auto-download limit set", downloadLimitToast("1048576"))
    }

    @Test fun textOnlyModeStorage() {
        assertEquals("unknown", textOnlyModeOf(null))
        assertEquals("unknown", textOnlyModeOf("junk"))
        assertEquals("all", textOnlyModeOf("all"))
        assertEquals(null, textOnlyStored("unknown"))
        assertEquals("off", textOnlyStored("off"))
        assertEquals("All messages", textOnlyLabel("all"))
        assertEquals("Unknown senders", textOnlyLabel("unknown"))
    }

    @Test fun coverRules() {
        // "unknown": only an unaccepted request, never our own or the device's.
        assertTrue(coversAttachment(photo(), "unknown", "deaddrop"))
        assertFalse(coversAttachment(photo(), "unknown", "single"))
        assertFalse(coversAttachment(photo(from = 1), "unknown", "deaddrop"))
        assertFalse(coversAttachment(photo(from = 5), "unknown", "deaddrop"))
        assertTrue(coversAttachment(photo(from = 1), "all", "single"))
        assertFalse(coversAttachment(photo(), "off", "deaddrop"))
        // Text and metadata-less rows are never covered; nor service messages.
        assertFalse(coversAttachment(MessageObject(viewType = "Text", text = "hi"), "all", "single"))
        assertFalse(coversAttachment(MessageObject(viewType = "File"), "all", "single"))
        assertFalse(coversAttachment(photo().copy(isInfo = true), "all", "single"))
        assertTrue(coversAttachment(MessageObject(viewType = "Gif", fileName = "x.gif"), "all", "single"))
    }

    @Test fun hiddenCardLabels() {
        assertEquals("Photo", hiddenKindLabel("Gif"))
        assertEquals("Voice message", hiddenKindLabel("Voice"))
        assertEquals("Webxdc app", hiddenKindLabel("Webxdc"))
        assertEquals("Show", revealActionLabel("Done"))
        assertEquals("Show", revealActionLabel(null))
        assertEquals("Download and show", revealActionLabel("Available"))
        assertEquals("3:42", revealKey(3, 42))
    }

    @Test fun downloadCards() {
        assertFalse(needsDownloadCard(photo()))
        assertTrue(needsDownloadCard(photo(ds = "Available")))
        assertFalse(needsDownloadCard(MessageObject(viewType = "Webxdc", downloadState = "Available")))
        val voice = MessageObject(viewType = "Voice", downloadState = "Available", fileBytes = 999)
        assertEquals("Voice message", downloadCardName(voice))
        assertEquals("Tap to download", downloadCardSub(voice, "999 B"))
        assertEquals("2 KB", downloadCardSub(photo(ds = "Available"), "2 KB"))
        assertEquals("Tap to download", downloadCardSub(photo(ds = "Available"), null))
        assertEquals("Downloading…", downloadCardSub(photo(ds = "InProgress"), "2 KB"))
        assertEquals("a.jpg", downloadCardName(photo()))
    }

    @Test fun coveredSheetDropsDownload() {
        val open = messageSheetActions(photo(), SheetContext())
        val hidden = messageSheetActions(photo(), SheetContext(covered = true))
        assertTrue(SheetAction.Download in open)
        assertFalse(SheetAction.Download in hidden)
        val sticker = photo().copy(viewType = "Sticker")
        assertTrue(SheetAction.SaveSticker in messageSheetActions(sticker, SheetContext()))
        assertFalse(SheetAction.SaveSticker in messageSheetActions(sticker, SheetContext(covered = true)))
    }

    @Test fun imageQualityOptionsAndToasts() {
        assertEquals(listOf("0", "1"), MEDIA_QUALITY_OPTIONS.map { it.first })
        assertEquals("0", savedMediaQuality(null))
        assertEquals("0", savedMediaQuality("junk"))
        assertEquals("1", savedMediaQuality("1"))
        assertEquals("Image quality: Compact", mediaQualityToast("1"))
        assertEquals("Image quality: Standard", mediaQualityToast("0"))
    }

    @Test fun summaryStringsUseTheStateTemplate() {
        // ui.js toggleText: "{label}: {state}" with on/off translated.
        assertEquals("Strip tracking from links: off", toggleSummary("Strip tracking from links", on = false))
        assertEquals("Theme: Brutal", choiceSummary("Theme", "Brutal"))
        L.lang = "ru"
        try {
            assertEquals("Тема: Тёмная", choiceSummary("Theme", themeLabel(VeltaThemeChoice.Dark)))
            assertEquals("Убирать следку из ссылок: вкл", toggleSummary("Strip tracking from links", on = true))
        } finally {
            L.lang = "en"
        }
    }
}
