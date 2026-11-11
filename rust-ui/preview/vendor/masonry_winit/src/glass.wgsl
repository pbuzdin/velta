// velta-glass: rounded-rectangle lens; only the rim distorts. Foreground stays sharp.
// Vello compute writes straight alpha; Vello Hybrid writes premultiplied alpha.
override foreground_straight: bool = false;
struct Lens { bounds: vec4<f32>, effect: vec4<f32> }
struct Params { viewport: vec4<f32>, lenses: array<Lens, 16> }
@group(0) @binding(0) var backdrop: texture_2d<f32>;
@group(0) @binding(1) var foreground: texture_2d<f32>;
@group(0) @binding(2) var linear_sampler: sampler;
@group(0) @binding(3) var<uniform> params: Params;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u);
    let y = f32(i & 2u);
    return vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}
fn sdf(p: vec2<f32>, half_size: vec2<f32>, radius: f32) -> f32 {
    let q = abs(p) - half_size + vec2<f32>(radius);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}
fn sample_bg(p: vec2<f32>) -> vec3<f32> {
    return textureSampleLevel(backdrop, linear_sampler, p / params.viewport.xy, 0.0).rgb;
}
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let p = pos.xy;
    var color = sample_bg(p);
    let scale = params.viewport.w;
    for (var i = 0u; i < u32(params.viewport.z); i++) {
        let lens = params.lenses[i];
        let center = (lens.bounds.xy + lens.bounds.zw) * 0.5;
        let half_size = (lens.bounds.zw - lens.bounds.xy) * 0.5;
        let local = p - center;
        let d = sdf(local, half_size, lens.effect.x);
        if (d > 1.0) { continue; }
        let coverage = 1.0 - smoothstep(-0.8, 0.8, d);
        let gradient = vec2<f32>(
            sdf(local + vec2<f32>(0.5, 0.0), half_size, lens.effect.x) - sdf(local - vec2<f32>(0.5, 0.0), half_size, lens.effect.x),
            sdf(local + vec2<f32>(0.0, 0.5), half_size, lens.effect.x) - sdf(local - vec2<f32>(0.0, 0.5), half_size, lens.effect.x));
        let normal = gradient / max(length(gradient), 0.001);
        let rim = 1.0 - smoothstep(0.0, 18.0 * scale, -d);
        let refracted = p - normal * lens.effect.y * rim * rim;
        let blur = 1.6 * scale;
        var glass = sample_bg(refracted) * 0.2;
        for (var y = -1; y <= 1; y++) {
            for (var x = -1; x <= 1; x++) {
                if (x == 0 && y == 0) { continue; }
                glass += sample_bg(refracted + vec2<f32>(f32(x), f32(y)) * blur) * 0.1;
            }
        }
        let split = normal * 0.65 * scale * rim;
        glass.r = mix(glass.r, sample_bg(refracted + split).r, rim * 0.35);
        glass.b = mix(glass.b, sample_bg(refracted - split).b, rim * 0.35);
        // A dark tint keeps the light labels readable even over a white QR code.
        glass = mix(glass, vec3<f32>(0.07, 0.09, 0.13), 0.68);
        let highlight = exp(-abs(d + 1.0 * scale) / (0.75 * scale));
        let light = 0.055 + 0.13 * max(dot(normal, normalize(vec2<f32>(-0.6, -0.8))), 0.0);
        glass += vec3<f32>(light * highlight);
        color = mix(color, glass, coverage);
    }
    let fg = textureSampleLevel(foreground, linear_sampler, p / params.viewport.xy, 0.0);
    let rgb = select(fg.rgb, fg.rgb * fg.a, foreground_straight);
    return vec4<f32>(rgb + color * (1.0 - fg.a), 1.0);
}
