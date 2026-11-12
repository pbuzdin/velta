package org.velta.kmp.ui

import android.graphics.RuntimeShader
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asComposeRenderEffect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import kotlin.math.min
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Web glass-composer.js lens: a rounded slab, steep at the rim and flat
 * in the middle. Bevel is 46% of the short side. The offset is Snell's law
 * at IOR 1.5, normalized so the rim shifts by [strength] px.
 */
private const val GLASS_AGSL = """
uniform shader contents;
uniform float2 size;
uniform float radius;
uniform float strength;
uniform float blur;
uniform float plateMix;
uniform float3 plate;

float sd(float2 p, float2 b, float r) {
  float2 q = abs(p) - b + float2(r);
  return length(max(q, float2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

half4 main(float2 coord) {
  float2 b = size * 0.5;
  float2 local = coord - b;
  float d = sd(local, b, radius);
  float coverage = 1.0 - smoothstep(-0.8, 0.8, d);
  float gx = sd(local + float2(0.5, 0.0), b, radius) - sd(local - float2(0.5, 0.0), b, radius);
  float gy = sd(local + float2(0.0, 0.5), b, radius) - sd(local - float2(0.0, 0.5), b, radius);
  float2 n = float2(gx, gy) / max(length(float2(gx, gy)), 0.001);
  float bevel = max(8.0, min(size.x, size.y) * 0.46);
  float t = clamp((-d) / bevel, 0.0, 1.0);
  float u = 1.0 - t;
  float z = sqrt(max(0.0, 1.0 - u * u));
  float slope = z < 0.02 ? 40.0 : u / z;
  float theta = atan(slope);
  float snell = sin(theta) / 1.5;
  float bend = snell >= 1.0 ? slope : tan(theta - asin(snell));
  float amount = clamp(bend / 1.05, 0.0, 1.0);
  float2 shift = n * (strength * amount);
  // The plate raster ends at its own edges; refraction at the left/right
  // ends of a full-width bar would sample outside it (transparent garbage)
  // unless the sample point is clamped inside.
  float2 lo = float2(0.5);
  float2 hi = size - float2(0.5);
  float2 ref = clamp(coord - shift, lo, hi);
  half4 glass = contents.eval(ref);
  half3 acc = half3(glass.rgb);
  // Frost: two rings of 8 taps around the refracted point (1 + 16 samples).
  for (int i = 0; i < 8; i++) {
    float a = 6.2831853 * (float(i) + 0.5) / 8.0;
    float2 o = float2(cos(a), sin(a));
    acc += half3(contents.eval(clamp(ref + o * blur, lo, hi)).rgb);
    acc += half3(contents.eval(clamp(ref + o * blur * 0.55, lo, hi)).rgb);
  }
  glass.rgb = acc / 17.0;
  half4 cr = contents.eval(clamp(ref + shift * 0.08, lo, hi));
  half4 cb = contents.eval(clamp(ref - shift * 0.08, lo, hi));
  glass.r = mix(glass.r, cr.r, amount * 0.55);
  glass.b = mix(glass.b, cb.b, amount * 0.55);
  glass.r = mix(glass.r, half(plate.r), plateMix);
  glass.g = mix(glass.g, half(plate.g), plateMix);
  glass.b = mix(glass.b, half(plate.b), plateMix);
  float spec = (0.07 + 0.12 * max(dot(n, normalize(float2(-0.6, -0.8))), 0.0))
      * exp(-abs(d + 1.0) / 2.4) * amount;
  return half4(glass.r + spec, glass.g + spec, glass.b + spec, coverage);
}
"""

@Composable
internal actual fun GlassPlate(
    backdrop: GraphicsLayer,
    hostInRoot: Offset,
    modifier: Modifier,
    radius: Dp,
    lens: Boolean,
    content: @Composable () -> Unit,
) {
    val plate = MaterialTheme.colorScheme.surface
    val shape = RoundedCornerShape(radius)
    var origin by remember { mutableStateOf(Offset.Zero) }
    Box(
        modifier
            .onGloballyPositioned { origin = it.positionInRoot() - hostInRoot }
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = {},
            ),
    ) {
        if (!lens || Build.VERSION.SDK_INT < 31) {
            Box(
                Modifier
                    .matchParentSize()
                    .background(if (lens) plate.copy(alpha = 0.88f) else plate, shape),
            )
        } else {
            val shader = remember {
                if (Build.VERSION.SDK_INT < 33) null
                else runCatching { RuntimeShader(GLASS_AGSL) }.getOrNull()
            }
            val radiusPx = with(LocalDensity.current) { radius.toPx() }
            val mix = if (plate.luminance() < 0.5f) 0.22f else 0.12f
            Box(
                Modifier
                    .matchParentSize()
                    .graphicsLayer {
                        // Shift stays a fraction of this plate, so the header and
                        // the composer each bend inside their own bar.
                        clip = true
                        this.shape = shape
                        renderEffect = if (shader != null && Build.VERSION.SDK_INT >= 33) {
                            val short = min(size.width, size.height)
                            shader.setFloatUniform("size", size.width, size.height)
                            shader.setFloatUniform("radius", radiusPx)
                            shader.setFloatUniform("strength", short * 0.30f)
                            shader.setFloatUniform("blur", short * 0.10f)
                            shader.setFloatUniform("plateMix", mix)
                            shader.setFloatUniform("plate", plate.red, plate.green, plate.blue)
                            android.graphics.RenderEffect
                                .createRuntimeShaderEffect(shader, "contents")
                                .asComposeRenderEffect()
                        } else {
                            android.graphics.RenderEffect
                                .createBlurEffect(28f, 28f, android.graphics.Shader.TileMode.CLAMP)
                                .asComposeRenderEffect()
                        }
                    }
                    .drawBehind {
                        translate(-origin.x, -origin.y) {
                            drawLayer(backdrop)
                        }
                    },
            )
            if (radiusPx > 0f) {
                Box(
                    Modifier
                        .matchParentSize()
                        .border(1.dp, Color.White.copy(alpha = 0.28f), shape),
                )
            }
        }
        content()
    }
}
