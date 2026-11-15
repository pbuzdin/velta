package org.velta.kmp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.delay

/** Shared state between the common player chrome and the platform video
 *  surface (Android VideoView). The surface fills in what it learns and
 *  wires the commands. */
class VideoControl(val startMs: Long, rate: Float) {
    var playing by mutableStateOf(false)
    var posMs by mutableLongStateOf(0L)
    var durMs by mutableLongStateOf(0L)
    var videoW by mutableIntStateOf(0)
    var videoH by mutableIntStateOf(0)
    var failed by mutableStateOf(false)
    var rate by mutableFloatStateOf(rate)
        internal set
    var onPlay: () -> Unit = {}
    var onPause: () -> Unit = {}
    var onSeek: (Long) -> Unit = {}
    var onRate: (Float) -> Unit = {}

    fun toggle() = if (playing) onPause() else onPlay()
    fun seek(ms: Long) { posMs = ms; onSeek(ms) }
    fun setSpeed(r: Float) { rate = r; onRate(r) }
}

/** The platform video surface: plays [path] from [control].startMs,
 *  reports progress into [control]; [stretch] = object-fit: cover. */
@Composable
expect fun VideoSurface(path: String, control: VideoControl, stretch: Boolean, modifier: Modifier)

private val VBOX_BG = Color(0xF5101010)
private val VBOX_INK = Color(0xFFF4F4F4)

/**
 * Stable openVideoLightbox (ui.js): the image lightbox shell with Stretch,
 * a playback-speed choice (0.5–2×, remembered) and close in the bar; the
 * player plays at once, resumes where it was left, and a tap on the
 * picture plays/pauses (it never closes). Back closes.
 */
@Composable
internal fun VideoLightbox(model: AppModel) {
    val box = model.videoBox ?: return
    val close = { model.videoBox = null }
    val control = remember(box.path) {
        VideoControl(startMs = model.videoResumeAt(box.path, Long.MAX_VALUE / 2) * 1000, rate = model.videoRate)
    }
    var stretch by remember(box.path) { mutableStateOf(false) }
    // Stable commit(): every ~2 s while playing, on pause and on close.
    val commit = {
        if (control.durMs > 0) model.saveVideoPosition(box.path, control.posMs / 1000, control.durMs / 1000)
    }
    LaunchedEffect(control) {
        while (true) {
            delay(2000)
            if (control.playing) commit()
        }
    }
    LaunchedEffect(control.playing) { if (!control.playing) commit() }
    DisposableEffect(control) { onDispose { commit() } }
    Dialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false),
    ) {
        Box(Modifier.fillMaxSize().background(VBOX_BG)) {
            Box(
                Modifier
                    .fillMaxSize()
                    .then(if (stretch) Modifier else Modifier.windowInsetsPadding(WindowInsets.statusBars).padding(top = 56.dp, bottom = 64.dp))
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        role = Role.Button,
                        onClickLabel = if (control.playing) L.t("Pause") else L.t("Play"),
                    ) { control.toggle() },
                contentAlignment = Alignment.Center,
            ) {
                if (control.failed) {
                    Text(L.t("Video can't be played"), color = VBOX_INK, fontSize = 14.sp)
                } else {
                    VideoSurface(box.path, control, stretch, Modifier.fillMaxSize())
                }
            }
            Column(Modifier.fillMaxSize()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .then(if (stretch) Modifier.background(Brush.verticalGradient(listOf(Color(0x8C000000), Color.Transparent))) else Modifier)
                        .windowInsetsPadding(WindowInsets.statusBars)
                        .padding(start = 14.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        box.caption,
                        fontSize = 14.sp,
                        color = VBOX_INK,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).alpha(0.85f),
                    )
                    TextButton(
                        onClick = { stretch = !stretch },
                        modifier = Modifier.semantics { stateDescription = if (stretch) "on" else "off" },
                    ) { Text(L.t("Stretch"), color = VBOX_INK, fontSize = 13.sp) }
                    SpeedChoice(control.rate, VBOX_INK) { r -> control.setSpeed(r); model.setVideoRateChoice(r) }
                    IconButton(onClick = close) {
                        Icon(VeltaIcons.close, contentDescription = L.t("Close"), tint = VBOX_INK)
                    }
                }
                Spacer(Modifier.weight(1f))
                VideoControls(control)
            }
        }
    }
}

@Composable
private fun SpeedChoice(rate: Float, ink: Color, onPick: (Float) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(
            onClick = { open = true },
            modifier = Modifier.semantics { contentDescription = L.t("Playback speed") + ": " + speedLabel(rate) },
        ) { Text(speedLabel(rate), color = ink, fontSize = 13.sp) }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (r in VIDEO_RATES) {
                DropdownMenuItem(text = { Text(speedLabel(r)) }, onClick = { open = false; onPick(r) })
            }
        }
    }
}

@Composable
private fun VideoControls(control: VideoControl) {
    var dragging by remember { mutableStateOf<Float?>(null) }
    val total = control.durMs.toFloat()
    Row(
        Modifier
            .fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0x8C000000))))
            .windowInsetsPadding(WindowInsets.navigationBars)
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = { control.toggle() }) {
            Icon(
                if (control.playing) VeltaIcons.pauseFilled else VeltaIcons.playFilled,
                contentDescription = if (control.playing) L.t("Pause") else L.t("Play"),
                tint = VBOX_INK,
            )
        }
        Slider(
            value = (dragging ?: control.posMs.toFloat()).coerceIn(0f, total.coerceAtLeast(0f)),
            onValueChange = { dragging = it },
            onValueChangeFinished = { dragging?.let { control.seek(it.toLong()) }; dragging = null },
            valueRange = 0f..total.coerceAtLeast(1f),
            enabled = total > 0f,
            colors = SliderDefaults.colors(thumbColor = VBOX_INK, activeTrackColor = VBOX_INK, inactiveTrackColor = VBOX_INK.copy(alpha = 0.3f)),
            modifier = Modifier.weight(1f).semantics { contentDescription = L.t("Seek") },
        )
        Spacer(Modifier.width(8.dp))
        Text(
            audioTimeLabel((dragging?.toLong() ?: control.posMs), control.durMs),
            color = VBOX_INK,
            fontSize = 12.sp,
            modifier = Modifier.alpha(0.85f).padding(end = 6.dp),
        )
    }
}
