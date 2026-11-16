package org.velta.kmp.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Thumbnail decode cap: the box is 96×64dp, 3× density covers it. */
private const val THUMB_MAX_SIDE = 320

/**
 * Pending attachment strip (stable #media-preview, main.css .media-preview):
 * a 96×64 letterboxed thumbnail, the name, Edit for pictures (stable: Crop),
 * and a remove button. Videos show their first frame with a play badge and
 * the duration. Styling stays close to stable until a reply/attachment bar
 * variant is picked (#334).
 */
@Composable
internal fun AttachmentPreview(model: AppModel, path: String, name: String) {
    val tokens = Velta.tokens
    val kind = remember(name) { shareViewtype(name) }
    var thumb by remember(path) { mutableStateOf<ImageBitmap?>(null) }
    var durationMs by remember(path) { mutableStateOf(0L) }
    var editing by remember(path) { mutableStateOf(false) }
    LaunchedEffect(path) {
        withContext(Dispatchers.Default) {
            when (kind) {
                "image" -> thumb = decodeImageScaled(path, THUMB_MAX_SIDE)
                "video" -> readVideoInfo(path, THUMB_MAX_SIDE)?.let { thumb = it.frame; durationMs = it.durationMs }
            }
        }
    }
    if (editing) {
        ImageEditorDialog(
            path = path,
            name = name,
            onDone = { p, n -> editing = false; model.onAttachmentEdited(p, n) },
            onCancel = { editing = false },
        )
    }
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier.size(width = 96.dp, height = 64.dp).clip(RoundedCornerShape(8.dp)).background(tokens.bgHover),
            contentAlignment = Alignment.Center,
        ) {
            val t = thumb
            if (t != null) {
                Image(t, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.size(width = 96.dp, height = 64.dp))
            } else {
                Icon(
                    when (kind) { "image" -> VeltaIcons.photo; "video" -> VeltaIcons.video; else -> VeltaIcons.file },
                    contentDescription = null,
                    tint = tokens.textDim,
                    modifier = Modifier.size(24.dp),
                )
            }
            if (kind == "video") {
                // Play badge + duration on a scrim: white on ≥60% black is AA on any frame.
                Box(
                    Modifier.size(28.dp).clip(CircleShape).background(Color(0x99000000)),
                    contentAlignment = Alignment.Center,
                ) { Icon(VeltaIcons.playFilled, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp)) }
                if (durationMs > 0) {
                    Text(
                        formatClipDuration(durationMs),
                        color = Color.White,
                        fontSize = 10.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.align(Alignment.BottomStart).padding(4.dp)
                            .clip(RoundedCornerShape(6.dp)).background(Color(0xAD000000))
                            .padding(horizontal = 5.dp, vertical = 1.dp),
                    )
                }
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                name.ifBlank { L.t(if (kind == "video") "Video" else "Photo") },
                fontSize = 13.5.sp,
                color = tokens.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (kind == "image" && canEditImage(name)) {
                TextButton(onClick = { editing = true }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 2.dp)) {
                    Icon(EditorIcons.crop, contentDescription = null, tint = tokens.accentText, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(L.t("Edit"), color = tokens.accentText, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        IconButton(onClick = { model.pendingAttachment = null }) {
            Icon(VeltaIcons.close, contentDescription = L.t("Remove attachment"), tint = tokens.textDim)
        }
    }
}
