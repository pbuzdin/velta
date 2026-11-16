package org.velta.kmp.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.systemGestures
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// Always-dark stage like stable's cropper (#0b0b10 stage, #f2f2f5 ink).
private val ED_STAGE = Color(0xFF0B0B10)
private val ED_BAR = Color(0xFF181820)
private val ED_CHIP = Color(0xFF1C1C26)
private val ED_INK = Color(0xFFF2F2F5)
private val ED_DIM = Color(0xFFA3A3AD) // 7.0:1 on ED_BAR
private val ED_LINE = Color(0x1FF4F4F4)

private enum class EditMode { Crop, Draw }

/**
 * Draw the source picture with its brush strokes, turned by [st]'s quarter
 * turns, into a [rw]×[rh] frame at the current origin (scale applied by the
 * caller). Shared by the on-screen stage and the final render.
 */
private fun DrawScope.drawEdited(src: ImageBitmap, st: EditState, rw: Float, rh: Float, live: BrushStroke?) {
    val sw = src.width.toFloat()
    val sh = src.height.toFloat()
    withTransform({
        translate(rw / 2f, rh / 2f)
        rotate(90f * st.quarterTurns, pivot = Offset.Zero)
        translate(-sw / 2f, -sh / 2f)
    }) {
        drawImage(src)
        val unit = minOf(sw, sh)
        for (s in if (live != null) st.strokes + live else st.strokes) {
            if (s.points.isEmpty()) continue
            val color = Color(s.argb.toInt())
            val width = s.width * unit
            if (s.points.size == 1) {
                val (x, y) = s.points[0]
                drawCircle(color, radius = width / 2f, center = Offset(x * sw, y * sh))
                continue
            }
            val path = Path().apply {
                val (x0, y0) = s.points[0]
                moveTo(x0 * sw, y0 * sh)
                for (i in 1 until s.points.size) {
                    val (x, y) = s.points[i]
                    lineTo(x * sw, y * sh)
                }
            }
            drawPath(path, color, style = Stroke(width = width, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}

/** Final pixels: rotate, paint, crop at the decoded resolution. */
internal fun renderEdit(src: ImageBitmap, st: EditState): ImageBitmap {
    val (rw, rh) = rotatedSize(src.width, src.height, st.quarterTurns)
    val (cl, ct, cw, ch) = cropPixels(st.crop, rw, rh).let { listOf(it[0], it[1], it[2], it[3]) }
    val out = ImageBitmap(cw, ch)
    val canvas = androidx.compose.ui.graphics.Canvas(out)
    CanvasDrawScope().draw(Density(1f), LayoutDirection.Ltr, canvas, Size(cw.toFloat(), ch.toFloat())) {
        translate(-cl.toFloat(), -ct.toFloat()) { drawEdited(src, st, rw.toFloat(), rh.toFloat(), null) }
    }
    return out
}

/**
 * Pre-send image editor (#334): stable's crop (openImageCropper) plus
 * aspect presets, 90° rotation and a brush with undo/redo. Done writes a
 * JPEG into app scratch and hands back (path, name); an untouched picture
 * just closes.
 */
@Composable
internal fun ImageEditorDialog(
    path: String,
    name: String,
    onDone: (path: String, name: String) -> Unit,
    onCancel: () -> Unit,
) {
    var src by remember(path) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(path) { mutableStateOf(false) }
    LaunchedEffect(path) {
        val img = withContext(Dispatchers.Default) { decodeImageScaled(path, EDIT_MAX_SIDE) }
        if (img == null) failed = true else src = img
    }
    val history = remember(path) { EditHistory() }
    var st by remember(path) { mutableStateOf(EditState()) }
    var undoState by remember(path) { mutableStateOf(false to false) }
    fun commit(next: EditState) {
        history.push(next)
        st = history.current
        undoState = history.canUndo to history.canRedo
    }
    var mode by remember(path) { mutableStateOf(EditMode.Crop) }
    var brushColor by remember { mutableStateOf(BRUSH_COLORS[2]) }
    var brushSize by remember { mutableStateOf(BRUSH_DEFAULT) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val accent = Velta.tokens.accent
    val onAccent = Velta.tokens.onAccent

    Dialog(
        onDismissRequest = onCancel,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false),
    ) {
        Column(Modifier.fillMaxSize().background(ED_STAGE)) {
            // Top bar: cancel · title · undo · redo · done.
            Row(
                Modifier.fillMaxWidth().background(ED_BAR)
                    .windowInsetsPadding(WindowInsets.statusBars)
                    .height(56.dp).padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onCancel) { Icon(VeltaIcons.close, contentDescription = L.t("Cancel"), tint = ED_INK) }
                Text(
                    L.t(if (mode == EditMode.Crop) "Edit photo" else "Draw"),
                    color = ED_INK, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f).padding(start = 4.dp),
                )
                IconButton(onClick = { st = history.undo(); undoState = history.canUndo to history.canRedo }, enabled = undoState.first) {
                    Icon(EditorIcons.undo, contentDescription = L.t("Undo"), tint = if (undoState.first) ED_INK else ED_DIM.copy(alpha = 0.5f))
                }
                IconButton(onClick = { st = history.redo(); undoState = history.canUndo to history.canRedo }, enabled = undoState.second) {
                    Icon(EditorIcons.redo, contentDescription = L.t("Redo"), tint = if (undoState.second) ED_INK else ED_DIM.copy(alpha = 0.5f))
                }
                Box(
                    Modifier.padding(start = 4.dp, end = 4.dp).size(40.dp).clip(CircleShape).background(accent)
                        .clickable(enabled = !saving && src != null, role = Role.Button) {
                            val image = src ?: return@clickable
                            if (!st.edited) { onCancel(); return@clickable }
                            saving = true
                            val state = st
                            scope.launch {
                                val out = withContext(Dispatchers.Default) {
                                    saveEditedJpeg(renderEdit(image, state), editedName(name))
                                }
                                saving = false
                                if (out != null) onDone(out, editedName(name)) else failed = true
                            }
                        }
                        .semantics { contentDescription = L.t("Done") },
                    contentAlignment = Alignment.Center,
                ) {
                    if (saving) CircularProgressIndicator(Modifier.size(20.dp), color = onAccent, strokeWidth = 2.dp)
                    else Icon(VeltaIcons.check, contentDescription = null, tint = onAccent, modifier = Modifier.size(22.dp))
                }
            }
            // Stage: kept clear of the system gesture edges so frame handles
            // never fight Android's back swipe.
            BoxWithConstraints(
                Modifier.weight(1f).fillMaxWidth()
                    .windowInsetsPadding(WindowInsets.systemGestures.only(WindowInsetsSides.Horizontal))
                    .padding(16.dp),
                contentAlignment = Alignment.Center,
            ) {
                val image = src
                if (image == null) {
                    if (failed) Text(L.t("Couldn't open the image"), color = ED_INK)
                    else CircularProgressIndicator(color = ED_INK)
                    return@BoxWithConstraints
                }
                EditorStage(
                    image = image,
                    st = st,
                    mode = mode,
                    brushColor = brushColor,
                    brushSize = brushSize,
                    stage = IntSize(constraints.maxWidth, constraints.maxHeight),
                    onLive = { st = it },
                    onCommit = { commit(it) },
                )
            }
            // Tools.
            Column(Modifier.fillMaxWidth().background(ED_STAGE).padding(horizontal = 16.dp, vertical = 8.dp)) {
                val image = src
                if (mode == EditMode.Crop) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconButton(
                            onClick = { if (image != null) commit(st.rotatedCw(image.width, image.height)) },
                            modifier = Modifier.clip(CircleShape).background(ED_CHIP),
                        ) { Icon(EditorIcons.rotate, contentDescription = L.t("Rotate"), tint = ED_INK) }
                        Spacer(Modifier.width(12.dp))
                        Text(L.t("Drag the corners or edges to crop"), color = ED_DIM, fontSize = 12.5.sp, modifier = Modifier.weight(1f))
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()).selectableGroup(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        for (p in AspectPreset.entries) {
                            val on = st.preset == p
                            Text(
                                if (p == AspectPreset.Free || p == AspectPreset.Original) L.t(p.label) else p.label,
                                color = if (on) onAccent else ED_INK,
                                fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.clip(RoundedCornerShape(16.dp))
                                    .background(if (on) accent else ED_CHIP)
                                    .selectable(selected = on, role = Role.RadioButton) {
                                        if (image != null) commit(st.withPreset(p, image.width, image.height))
                                    }
                                    .padding(horizontal = 14.dp, vertical = 8.dp),
                            )
                        }
                    }
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(EditorIcons.brush, contentDescription = null, tint = ED_DIM, modifier = Modifier.size(18.dp))
                        Slider(
                            value = brushSize,
                            onValueChange = { brushSize = it },
                            valueRange = BRUSH_MIN..BRUSH_MAX,
                            colors = SliderDefaults.colors(thumbColor = ED_INK, activeTrackColor = accent, inactiveTrackColor = ED_LINE),
                            modifier = Modifier.weight(1f).padding(horizontal = 10.dp)
                                .semantics { contentDescription = L.t("Brush size") },
                        )
                        Box(Modifier.size(30.dp).border(1.5.dp, ED_LINE, CircleShape), contentAlignment = Alignment.Center) {
                            val d = (6 + 18 * (brushSize - BRUSH_MIN) / (BRUSH_MAX - BRUSH_MIN)).dp
                            Box(Modifier.size(d).clip(CircleShape).background(Color(brushColor.toInt())))
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(
                        Modifier.fillMaxWidth().selectableGroup(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        for ((i, c) in BRUSH_COLORS.withIndex()) {
                            val on = c == brushColor
                            Box(
                                Modifier.size(34.dp)
                                    .then(if (on) Modifier.border(2.dp, ED_INK, CircleShape) else Modifier)
                                    .padding(if (on) 4.dp else 2.dp)
                                    .clip(CircleShape)
                                    .background(Color(c.toInt()))
                                    .border(1.dp, ED_LINE, CircleShape)
                                    .selectable(selected = on, role = Role.RadioButton) { brushColor = c }
                                    .semantics { contentDescription = L.t(BRUSH_COLOR_NAMES[i]) },
                            )
                        }
                    }
                }
            }
            // Mode tabs.
            Row(
                Modifier.fillMaxWidth().background(ED_BAR)
                    .windowInsetsPadding(WindowInsets.navigationBars)
                    .padding(vertical = 8.dp).selectableGroup(),
            ) {
                for ((m, icon, label) in listOf(Triple(EditMode.Crop, EditorIcons.crop, "Crop"), Triple(EditMode.Draw, EditorIcons.brush, "Draw"))) {
                    val on = mode == m
                    Column(
                        Modifier.weight(1f).selectable(selected = on, role = Role.Tab) { mode = m }.padding(vertical = 4.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(icon, contentDescription = null, tint = if (on) accent else ED_DIM)
                        Text(L.t(label), color = if (on) accent else ED_DIM, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

/** English names for the swatches (TalkBack); translated via L.t. */
private val BRUSH_COLOR_NAMES = listOf("White", "Black", "Red", "Orange", "Yellow", "Green", "Blue", "Violet")

@Composable
private fun EditorStage(
    image: ImageBitmap,
    st: EditState,
    mode: EditMode,
    brushColor: Long,
    brushSize: Float,
    stage: IntSize,
    onLive: (EditState) -> Unit,
    onCommit: (EditState) -> Unit,
) {
    val (rw, rh) = rotatedSize(image.width, image.height, st.quarterTurns)
    val scale = minOf(stage.width / rw.toFloat(), stage.height / rh.toFloat())
    val w = rw * scale
    val h = rh * scale
    val ox = (stage.width - w) / 2f
    val oy = (stage.height - h) / 2f
    val liveSt by rememberUpdatedState(st)
    val liveColor by rememberUpdatedState(brushColor)
    val liveSize by rememberUpdatedState(brushSize)
    var liveStroke by remember { mutableStateOf<BrushStroke?>(null) }
    Canvas(
        Modifier.fillMaxSize().pointerInput(mode, rw, rh, scale) {
            val touch = 24.dp.toPx()
            awaitEachGesture {
                val down = awaitFirstDown()
                val start = liveSt
                if (mode == EditMode.Crop) {
                    val frame = NRect(ox + start.crop.l * w, oy + start.crop.t * h, ox + start.crop.r * w, oy + start.crop.b * h)
                    val handle = hitCropHandle(down.position.x, down.position.y, frame, touch) ?: return@awaitEachGesture
                    down.consume()
                    val ratio = presetRatio(start.preset, rw, rh)
                    var last = start
                    while (true) {
                        val ev = awaitPointerEvent()
                        val c = ev.changes.firstOrNull() ?: break
                        if (!c.pressed) break
                        val d = c.position - down.position
                        last = start.copy(crop = dragCrop(start.crop, handle, d.x / w, d.y / h, ratio, rw, rh))
                        onLive(last)
                        c.consume()
                    }
                    onLive(start)
                    onCommit(last)
                } else {
                    fun toSource(p: Offset): Pair<Float, Float> {
                        val u = ((p.x - ox) / w).coerceIn(0f, 1f)
                        val v = ((p.y - oy) / h).coerceIn(0f, 1f)
                        return rotatedToSource(u, v, start.quarterTurns)
                    }
                    down.consume()
                    val pts = mutableListOf(toSource(down.position))
                    liveStroke = BrushStroke(liveColor, liveSize, pts.toList())
                    while (true) {
                        val ev = awaitPointerEvent()
                        val c = ev.changes.firstOrNull() ?: break
                        if (!c.pressed) break
                        pts += toSource(c.position)
                        liveStroke = BrushStroke(liveColor, liveSize, pts.toList())
                        c.consume()
                    }
                    val done = liveStroke
                    liveStroke = null
                    if (done != null) onCommit(start.copy(strokes = start.strokes + done))
                }
            }
        },
    ) {
        translate(ox, oy) {
            withTransform({ scale(scale, scale, pivot = Offset.Zero) }) {
                drawEdited(image, st, rw.toFloat(), rh.toFloat(), liveStroke)
            }
        }
        val l = ox + st.crop.l * w
        val t = oy + st.crop.t * h
        val r = ox + st.crop.r * w
        val b = oy + st.crop.b * h
        // Shade outside the crop (stable: rgba(11,11,16,.55) box-shadow).
        val shade = Color(0x9E0B0B10)
        drawRect(shade, Offset(ox, oy), Size(w, t - oy))
        drawRect(shade, Offset(ox, b), Size(w, oy + h - b))
        drawRect(shade, Offset(ox, t), Size(l - ox, b - t))
        drawRect(shade, Offset(r, t), Size(ox + w - r, b - t))
        if (mode == EditMode.Crop) {
            val ink = Color(0xFFF2F2F5)
            drawRect(ink, Offset(l, t), Size(r - l, b - t), style = Stroke(1.5.dp.toPx()))
            clipRect(l, t, r, b) {
                for (i in 1..2) {
                    val x = l + (r - l) * i / 3f
                    val y = t + (b - t) * i / 3f
                    drawLine(ink.copy(alpha = 0.45f), Offset(x, t), Offset(x, b), 1f)
                    drawLine(ink.copy(alpha = 0.45f), Offset(l, y), Offset(r, y), 1f)
                }
            }
            val arm = 18.dp.toPx()
            val sw = 4.dp.toPx()
            for ((cx, cy, sx, sy) in listOf(
                listOf(l, t, 1f, 1f), listOf(r, t, -1f, 1f), listOf(l, b, 1f, -1f), listOf(r, b, -1f, -1f),
            )) {
                drawLine(ink, Offset(cx, cy), Offset(cx + sx * arm, cy), sw, cap = StrokeCap.Round)
                drawLine(ink, Offset(cx, cy), Offset(cx, cy + sy * arm), sw, cap = StrokeCap.Round)
            }
        }
    }
}
