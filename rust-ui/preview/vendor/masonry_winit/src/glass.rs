// velta-glass: a deliberately small, single-window prototype compositor.
//! Backdrop glass rectangles in logical window pixels. Call before redraw.
use masonry_core::kurbo::Rect;
use std::sync::Mutex;
use wgpu::*;

const MAX_RECTS: usize = 16;
static RECTS: Mutex<Vec<GlassRect>> = Mutex::new(Vec::new());

/// A rounded backdrop lens; radius and displacement strength are logical pixels.
#[derive(Clone, Copy, Debug)]
pub struct GlassRect {
    pub rect: Rect,
    pub radius: f64,
    pub strength: f64,
}

/// Replace the lenses. Empty disables the extra passes. Invalid values are ignored.
/// shortcut: global single-window state; key by window before adding more windows.
pub fn set_rects(rects: Vec<GlassRect>) {
    *RECTS.lock().unwrap() = rects.into_iter().filter(valid).take(MAX_RECTS).collect();
}
fn valid(r: &GlassRect) -> bool {
    [
        r.rect.x0, r.rect.y0, r.rect.x1, r.rect.y1, r.radius, r.strength,
    ]
    .iter()
    .all(|x| x.is_finite() && x.abs() < 1e6)
        && r.rect.width() > 0.0
        && r.rect.height() > 0.0
        && r.radius >= 0.0
        && r.strength >= 0.0
}
pub(crate) fn rects() -> Vec<GlassRect> {
    RECTS.lock().unwrap().clone()
}

pub(crate) struct Compositor {
    pub size: (u32, u32),
    pub base: Texture,
    pub base_view: TextureView,
    pub overlay: Texture,
    pub overlay_view: TextureView,
    pipeline: RenderPipeline,
    bindings: BindGroup,
    params: Buffer,
}
impl Compositor {
    pub fn new(device: &Device, width: u32, height: u32) -> Self {
        let texture = |label| {
            device.create_texture(&TextureDescriptor {
                label: Some(label),
                size: Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: TextureDimension::D2,
                format: TextureFormat::Rgba8Unorm,
                view_formats: &[],
                usage: TextureUsages::STORAGE_BINDING
                    | TextureUsages::TEXTURE_BINDING
                    | TextureUsages::COPY_DST
                    | TextureUsages::RENDER_ATTACHMENT,
            })
        };
        let base = texture("Glass backdrop");
        let overlay = texture("Glass sharp foreground");
        let base_view = base.create_view(&TextureViewDescriptor::default());
        let overlay_view = overlay.create_view(&TextureViewDescriptor::default());
        let params = device.create_buffer(&BufferDescriptor {
            label: Some("Glass rectangles"),
            size: (16 + MAX_RECTS * 32) as u64,
            usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let shader = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("Velta glass"),
            source: ShaderSource::Wgsl(include_str!("glass.wgsl").into()),
        });
        let layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("Glass layout"),
            entries: &[
                BindGroupLayoutEntry {
                    binding: 0,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Texture {
                        sample_type: TextureSampleType::Float { filterable: true },
                        view_dimension: TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                BindGroupLayoutEntry {
                    binding: 1,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Texture {
                        sample_type: TextureSampleType::Float { filterable: true },
                        view_dimension: TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                BindGroupLayoutEntry {
                    binding: 2,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Sampler(SamplerBindingType::Filtering),
                    count: None,
                },
                BindGroupLayoutEntry {
                    binding: 3,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Buffer {
                        ty: BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let sampler = device.create_sampler(&SamplerDescriptor {
            label: Some("Glass clamped linear"),
            mag_filter: FilterMode::Linear,
            min_filter: FilterMode::Linear,
            ..Default::default()
        });
        let bindings = device.create_bind_group(&BindGroupDescriptor {
            label: Some("Glass inputs"),
            layout: &layout,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(&base_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(&overlay_view),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: BindingResource::Sampler(&sampler),
                },
                BindGroupEntry {
                    binding: 3,
                    resource: params.as_entire_binding(),
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: Some("Glass pipeline layout"),
            bind_group_layouts: &[&layout],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
            label: Some("Glass composite"),
            layout: Some(&pipeline_layout),
            vertex: VertexState {
                module: &shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                // velta-glass: these backends expose different texture alpha conventions.
                compilation_options: PipelineCompilationOptions {
                    constants: &[(
                        "foreground_straight",
                        if cfg!(feature = "imaging_vello") {
                            1.0
                        } else {
                            0.0
                        },
                    )],
                    ..Default::default()
                },
                targets: &[Some(ColorTargetState {
                    format: TextureFormat::Rgba8Unorm,
                    blend: None,
                    write_mask: ColorWrites::ALL,
                })],
            }),
            primitive: PrimitiveState::default(),
            depth_stencil: None,
            multisample: MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        Self {
            size: (width, height),
            base,
            base_view,
            overlay,
            overlay_view,
            pipeline,
            bindings,
            params,
        }
    }
    // velta-glass: Hybrid uses load/store; transparent source-over cannot erase old glyphs.
    pub fn clear_overlay(&self, device: &Device, queue: &Queue) {
        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("Clear glass foreground"),
        });
        {
            let _pass = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("Clear glass foreground"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &self.overlay_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: Operations {
                        load: LoadOp::Clear(Color::TRANSPARENT),
                        store: StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
        }
        queue.submit([encoder.finish()]);
    }
    pub fn composite(
        &self,
        device: &Device,
        queue: &Queue,
        target: &TextureView,
        rects: &[GlassRect],
        scale: f64,
    ) {
        let mut data = vec![
            self.size.0 as f32,
            self.size.1 as f32,
            rects.len() as f32,
            scale as f32,
        ];
        for r in rects {
            let radius = r
                .radius
                .min(r.rect.width() * 0.5)
                .min(r.rect.height() * 0.5);
            data.extend(
                [
                    r.rect.x0, r.rect.y0, r.rect.x1, r.rect.y1, radius, r.strength, 0.0, 0.0,
                ]
                .map(|x| (x * scale) as f32),
            );
        }
        data.resize(4 + MAX_RECTS * 8, 0.0);
        let bytes: Vec<u8> = data.iter().flat_map(|x| x.to_ne_bytes()).collect();
        queue.write_buffer(&self.params, 0, &bytes);
        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("Glass composite"),
        });
        {
            let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("Glass composite"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: Operations {
                        load: LoadOp::Clear(Color::TRANSPARENT),
                        store: StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bindings, &[]);
            pass.draw(0..3, 0..1);
        }
        queue.submit([encoder.finish()]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_bad_geometry() {
        let r = GlassRect {
            rect: Rect::new(0.0, 1.0, 100.0, 50.0),
            radius: 20.0,
            strength: 8.0,
        };
        assert!(valid(&r));
        assert!(!valid(&GlassRect {
            strength: f64::NAN,
            ..r
        }));
        assert!(!valid(&GlassRect {
            rect: Rect::ZERO,
            ..r
        }));
        set_rects(vec![r; 30]);
        assert_eq!(rects().len(), MAX_RECTS);
        set_rects(vec![]);
    }
    #[test]
    #[ignore = "needs a GPU adapter (software GL is sufficient)"]
    fn composite_preserves_background_and_sharp_foreground() {
        let instance = Instance::new(&InstanceDescriptor {
            backends: Backends::from_env().unwrap_or(Backends::all()),
            ..Default::default()
        });
        let adapter =
            pollster::block_on(instance.request_adapter(&RequestAdapterOptions::default()))
                .unwrap();
        let (device, queue) =
            pollster::block_on(adapter.request_device(&DeviceDescriptor::default())).unwrap();
        let glass = Compositor::new(&device, 64, 64);
        let mut base = vec![0u8; 64 * 64 * 4];
        for y in 0..64usize {
            for x in 0..64usize {
                let n = (y * 64 + x) * 4;
                base[n..n + 4].copy_from_slice(&[(x * 4) as u8, (y * 4) as u8, 80, 255]);
            }
        }
        queue.write_texture(
            TexelCopyTextureInfo {
                texture: &glass.base,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            &base,
            TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(256),
                rows_per_image: None,
            },
            Extent3d {
                width: 64,
                height: 64,
                depth_or_array_layers: 1,
            },
        );
        queue.write_texture(
            TexelCopyTextureInfo {
                texture: &glass.overlay,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            &vec![255u8; 64 * 64 * 4],
            TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(256),
                rows_per_image: None,
            },
            Extent3d {
                width: 64,
                height: 64,
                depth_or_array_layers: 1,
            },
        );
        glass.clear_overlay(&device, &queue);
        // Exercise the real imaging backend too: their alpha conventions differ.
        let mut scene = masonry_core::imaging::record::Scene::new();
        {
            let mut painter = masonry_core::imaging::Painter::new(&mut scene);
            painter.fill_rect(
                Rect::new(2.0, 2.0, 3.0, 3.0),
                masonry_core::peniko::Color::from_rgba8(255, 0, 0, 128),
            );
            painter.fill_rect(
                Rect::new(30.0, 30.0, 34.0, 34.0),
                masonry_core::peniko::Color::from_rgb8(255, 0, 0),
            );
        }
        masonry_imaging::texture_render::Renderer::new()
            .render_to_texture(
                masonry_imaging::texture_render::RenderTarget {
                    adapter: &adapter,
                    device: &device,
                    queue: &queue,
                    texture: &glass.overlay,
                    view: &glass.overlay_view,
                },
                masonry_imaging::PreparedFrame::new(
                    64,
                    64,
                    1.0,
                    masonry_core::peniko::Color::TRANSPARENT,
                    &scene,
                    &[],
                ),
            )
            .unwrap();
        let target = device.create_texture(&TextureDescriptor {
            label: Some("Glass test output"),
            size: Extent3d {
                width: 64,
                height: 64,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        glass.composite(
            &device,
            &queue,
            &target.create_view(&Default::default()),
            &[GlassRect {
                rect: Rect::new(8.0, 8.0, 56.0, 56.0),
                radius: 12.0,
                strength: 8.0,
            }],
            1.0,
        );
        let readback = device.create_buffer(&BufferDescriptor {
            label: None,
            size: 64 * 256,
            usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            target.as_image_copy(),
            TexelCopyBufferInfo {
                buffer: &readback,
                layout: TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: None,
                },
            },
            Extent3d {
                width: 64,
                height: 64,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([encoder.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        readback.slice(..).map_async(MapMode::Read, move |r| {
            tx.send(r).unwrap();
        });
        device.poll(PollType::wait_indefinitely()).unwrap();
        rx.recv().unwrap().unwrap();
        let bytes = readback.slice(..).get_mapped_range();
        let pixel = |x: usize, y: usize| &bytes[(y * 64 + x) * 4..(y * 64 + x) * 4 + 4];
        assert_eq!(pixel(0, 0), &[0, 0, 80, 255], "outside lens unchanged");
        assert!(
            (pixel(2, 2)[0] as i32 - 132).abs() <= 1,
            "half-alpha foreground is not overbright"
        );
        assert_eq!(
            pixel(32, 32),
            &[255, 0, 0, 255],
            "foreground stays sharp and untinted"
        );
        assert_ne!(
            pixel(10, 32),
            &base[(32 * 64 + 10) * 4..(32 * 64 + 10) * 4 + 4],
            "rim changes backdrop"
        );
    }
}
