//! Screens: chat list and chat view, swapped inside one body slot.

use std::time::Instant;

use deltachat::chat::ChatId;
use masonry::app::RenderRoot;
use masonry::core::{ErasedAction, NewWidget, PropertySet, StyleProperty, WidgetId, WidgetTag};
use masonry::dpi::LogicalSize;
use masonry::kurbo::Point;
use masonry::layout::Length;
use masonry::peniko::color::AlphaColor;
use masonry::properties::types::{CrossAxisAlignment, MainAxisAlignment};
use masonry::properties::{Background, ContentColor, CornerRadius, LineBreaking, Padding};
use masonry::theme::default_property_set;
use masonry::peniko::{ImageAlphaType, ImageData, ImageFormat};
use masonry::widgets::{Button, ButtonPress, Flex, Image, Label, Portal, SizedBox, TextAction, TextArea, TextInput};
use masonry_winit::app::{AppDriver, DriverCtx, EventLoopProxy, MasonryUserEvent, NewWindow, WindowId};
use masonry_winit::app::MasonryState;
use masonry_winit::winit::application::ApplicationHandler;
use masonry_winit::winit::event::{DeviceEvent, DeviceId, ElementState, StartCause, WindowEvent};
use masonry_winit::winit::event_loop::ActiveEventLoop;
use masonry_winit::winit::keyboard::{Key, NamedKey};
use masonry_winit::winit::window::Window;

use crate::core::{Change, Core, Item};

const BG: AlphaColor<masonry::peniko::color::Srgb> = AlphaColor::from_rgb8(0x10, 0x12, 0x17);
const SURFACE: AlphaColor<masonry::peniko::color::Srgb> = AlphaColor::from_rgb8(0x1c, 0x1f, 0x26);
const OUT: AlphaColor<masonry::peniko::color::Srgb> = AlphaColor::from_rgb8(0x2f, 0x4a, 0x9e);
const TEXT: AlphaColor<masonry::peniko::color::Srgb> = AlphaColor::from_rgb8(0xf2, 0xf4, 0xf8);
const MUTED: AlphaColor<masonry::peniko::color::Srgb> = AlphaColor::from_rgb8(0xb4, 0xba, 0xc6);

const BODY: WidgetTag<SizedBox> = WidgetTag::named("body");
const TITLE: WidgetTag<Label> = WidgetTag::named("title");
const BACK: WidgetTag<Button> = WidgetTag::named("back");
const LOG: WidgetTag<Label> = WidgetTag::named("log");
const INVITE: WidgetTag<Button> = WidgetTag::named("invite");
// Masonry never drops a tag when its widget is removed, so widgets that get rebuilt
// (the chat screen) take a fresh unique tag each time instead of a named one.
struct ChatTags {
    send: WidgetTag<Button>,
    input: WidgetTag<TextInput>,
    msgs: WidgetTag<Portal<Flex>>,
}

const LIMIT: usize = 200;

#[derive(Debug)]
enum Async {
    Log,
    /// The phone's Back button (Escape on desktop).
    Back,
    Core(Change),
    ScrollBottom,
}

enum Screen {
    List { rows: Vec<(WidgetTag<Button>, ChatId)> },
    Chat { id: ChatId, draft: String, tags: ChatTags },
    Invite,
}

struct Driver {
    core: Core,
    window: WindowId,
    proxy: EventLoopProxy,
    screen: Screen,
    started: Option<Instant>,
    /// False until the first screen is built. On Android the window only exists after
    /// the activity resumes, so async actions posted before that are dropped.
    built: bool,
}

fn px(v: f64) -> Length {
    Length::px(v)
}

fn label(text: impl Into<String>, size: f32, color: AlphaColor<masonry::peniko::color::Srgb>) -> NewWidget<Label> {
    NewWidget::new(Label::new(text.into()).with_style(StyleProperty::FontSize(size)))
        .with_props(PropertySet::new().with(ContentColor::new(color)).with(LineBreaking::WordWrap))
}

fn one_line(text: impl Into<String>, size: f32, color: AlphaColor<masonry::peniko::color::Srgb>) -> NewWidget<Label> {
    NewWidget::new(Label::new(text.into()).with_style(StyleProperty::FontSize(size)))
        .with_props(PropertySet::new().with(ContentColor::new(color)).with(LineBreaking::Clip))
}

impl Driver {
    fn post(&self, a: Async) {
        let _ = self.proxy.send_event(MasonryUserEvent::AsyncAction(self.window, Box::new(a)));
    }

    fn set_title(root: &mut RenderRoot, title: &str, back: bool) {
        root.edit_widget_with_tag(TITLE, |mut l| Label::set_text(&mut l, title.to_string()));
        root.edit_widget_with_tag(BACK, |mut b| {
            Button::set_child(&mut b, NewWidget::new(Label::new(if back { "Back" } else { "Velta" }).with_style(StyleProperty::FontSize(22.0))));
        });
    }

    fn show_list(&mut self, root: &mut RenderRoot) {
        let t = Instant::now();
        let rows = self.core.chats().unwrap_or_default();
        let mut col = Flex::column().cross_axis_alignment(CrossAxisAlignment::Stretch);
        let mut map = Vec::with_capacity(rows.len());
        for r in &rows {
            let tag = WidgetTag::unique();
            let top = Flex::row()
                .with(one_line(r.name.clone(), 17.0, TEXT), 1.0)
                .with_fixed(one_line(
                    if r.unread > 0 { format!("{}  ·  {}", r.unread, r.time) } else { r.time.clone() },
                    13.0,
                    MUTED,
                ));
            let body = Flex::column()
                .cross_axis_alignment(CrossAxisAlignment::Stretch)
                .with_fixed(NewWidget::new(top))
                .with_fixed(one_line(r.summary.replace('\n', " "), 14.0, MUTED));
            let btn = NewWidget::new(Button::new(NewWidget::new(body)))
                .with_tag(tag)
                .with_props(
                    PropertySet::new()
                        .with(Background::Color(BG))
                        .with(CornerRadius::all(px(0.0)))
                        .with(Padding::from_vh(px(10.0), px(16.0))),
                );
            col = col.with_fixed(btn);
            map.push((tag, r.id));
        }
        let portal = Portal::new(NewWidget::new(col)).constrain_horizontal(true);
        root.edit_widget_with_tag(BODY, |mut b| SizedBox::set_child(&mut b, NewWidget::new(portal)));
        Self::set_title(root, "Chats", false);
        self.screen = Screen::List { rows: map };
        crate::say(format!("chat list ({} chats) built in {} ms", rows.len(), t.elapsed().as_millis()));
    }

    fn show_invite(&mut self, root: &mut RenderRoot) {
        let link = self.core.invite();
        let mut col = Flex::column().cross_axis_alignment(CrossAxisAlignment::Center).with_fixed_spacer(px(16.0));
        if link.is_empty() {
            col = col.with_fixed(label("Setting up your account on nine.testrun.org. Try again in a few seconds.", 16.0, TEXT));
        } else {
            col = col
                .with_fixed(label("Scan this in Velta (Add contact, then scan QR) to start a chat with this preview.", 16.0, TEXT))
                .with_fixed_spacer(px(16.0))
                .with_fixed(NewWidget::new(SizedBox::new(NewWidget::new(Image::new(qr_image(&link)))).size(px(300.0), px(300.0))))
                .with_fixed_spacer(px(16.0))
                .with_fixed(label(self.core.self_addr(), 13.0, MUTED));
        }
        let col = NewWidget::new(col).with_props(PropertySet::new().with(Padding::all(px(16.0))));
        root.edit_widget_with_tag(BODY, |mut b| SizedBox::set_child(&mut b, NewWidget::new(Portal::new(col).constrain_horizontal(true))));
        Self::set_title(root, "Invite", true);
        self.screen = Screen::Invite;
    }

    fn messages(&self, id: ChatId) -> Flex {
        let mut col = Flex::column().cross_axis_alignment(CrossAxisAlignment::Stretch);
        for it in self.core.items(id, LIMIT).unwrap_or_default() {
            match it {
                Item::Day(d) => {
                    col = col.with_fixed(NewWidget::new(
                        Flex::row().main_axis_alignment(MainAxisAlignment::Center).with_fixed(one_line(d, 12.0, MUTED)),
                    ));
                }
                Item::Msg { outgoing, sender, text, time, .. } => {
                    let mut bubble = Flex::column().cross_axis_alignment(CrossAxisAlignment::Start);
                    if let Some(s) = sender {
                        bubble = bubble.with_fixed(one_line(s, 13.0, MUTED));
                    }
                    bubble = bubble.with_fixed(label(text, 16.0, TEXT));
                    bubble = bubble.with_fixed(NewWidget::new(
                        Flex::row().main_axis_alignment(MainAxisAlignment::End).with_fixed(one_line(time, 11.0, MUTED)),
                    ));
                    let bubble = NewWidget::new(bubble).with_props(
                        PropertySet::new()
                            .with(Background::Color(if outgoing { OUT } else { SURFACE }))
                            .with(CornerRadius::all(px(14.0)))
                            .with(Padding::from_vh(px(6.0), px(10.0))),
                    );
                    let row = if outgoing {
                        Flex::row().with_spacer(0.25).with(bubble, 0.75)
                    } else {
                        Flex::row().with(bubble, 0.75).with_spacer(0.25)
                    };
                    let row = NewWidget::new(row).with_props(PropertySet::new().with(Padding::from_vh(px(3.0), px(8.0))));
                    col = col.with_fixed(row);
                }
            }
        }
        col
    }

    fn show_chat(&mut self, root: &mut RenderRoot, id: ChatId) {
        let t = Instant::now();
        self.core.mark_seen(id);
        let tags = ChatTags { send: WidgetTag::unique(), input: WidgetTag::unique(), msgs: WidgetTag::unique() };
        let msgs = NewWidget::new(Portal::new(NewWidget::new(self.messages(id))).constrain_horizontal(true)).with_tag(tags.msgs);
        let input = NewWidget::new(TextInput::new("").with_placeholder("Message")).with_tag(tags.input);
        let send = NewWidget::new(Button::with_text("Send")).with_tag(tags.send);
        let composer = NewWidget::new(Flex::row().with(input, 1.0).with_fixed_spacer(px(8.0)).with_fixed(send))
            .with_props(PropertySet::new().with(Padding::all(px(8.0))).with(Background::Color(SURFACE)));
        let screen = Flex::column().cross_axis_alignment(CrossAxisAlignment::Stretch).with(msgs, 1.0).with_fixed(composer);
        root.edit_widget_with_tag(BODY, |mut b| SizedBox::set_child(&mut b, NewWidget::new(screen)));
        Self::set_title(root, &self.core.chat_name(id), true);
        self.screen = Screen::Chat { id, draft: String::new(), tags };
        self.post(Async::ScrollBottom);
        crate::say(format!("chat {id} built in {} ms", t.elapsed().as_millis()));
    }

    fn refresh_chat(&mut self, root: &mut RenderRoot, id: ChatId) {
        let Screen::Chat { tags, .. } = &self.screen else { return };
        let msgs = tags.msgs;
        let col = self.messages(id);
        root.edit_widget_with_tag(msgs, |mut p| Portal::set_child(&mut p, NewWidget::new(col)));
        self.post(Async::ScrollBottom);
    }

    fn send(&mut self, root: &mut RenderRoot) {
        let Screen::Chat { id, draft, tags } = &mut self.screen else { return };
        let text = std::mem::take(draft);
        if text.trim().is_empty() {
            return;
        }
        let (id, input) = (*id, tags.input);
        if let Err(e) = self.core.send_text(id, text) {
            crate::say(format!("send failed: {e:#}"));
        }
        root.edit_widget_with_tag(input, |mut i| TextArea::reset_text(&mut TextInput::text_mut(&mut i), ""));
        self.refresh_chat(root, id);
    }
}

impl AppDriver for Driver {
    fn on_action(&mut self, window_id: WindowId, ctx: &mut DriverCtx<'_>, widget_id: WidgetId, action: ErasedAction) {
        let root = ctx.render_root(window_id);
        if action.is::<ButtonPress>() {
            let is = |root: &RenderRoot, tag: WidgetTag<Button>| root.get_widget_with_tag(tag).map(|w| w.id()) == Some(widget_id);
            if is(root, BACK) {
                if !matches!(self.screen, Screen::List { .. }) {
                    self.show_list(root);
                }
            } else if is(root, INVITE) {
                self.show_invite(root);
            } else if matches!(&self.screen, Screen::Chat { tags, .. } if is(root, tags.send)) {
                self.send(root);
            } else if let Screen::List { rows } = &self.screen {
                let hit = rows.iter().find(|(tag, _)| is(root, *tag)).map(|(_, id)| *id);
                if let Some(id) = hit {
                    self.show_chat(root, id);
                }
            }
        } else if action.is::<TextAction>() {
            match *action.downcast::<TextAction>().unwrap() {
                TextAction::Changed(t) => {
                    if let Screen::Chat { draft, .. } = &mut self.screen {
                        *draft = t;
                    }
                }
                TextAction::Entered(_) => self.send(root),
                TextAction::Cancelled => {}
            }
        }
    }

    fn on_async_action(&mut self, window_id: WindowId, ctx: &mut DriverCtx<'_>, action: ErasedAction) {
        let root = ctx.render_root(window_id);
        if let Some(started) = self.started.take() {
            crate::say(format!("first frame cycle after {} ms", started.elapsed().as_millis()));
        }
        let Ok(a) = action.downcast::<Async>() else { return };
        if !self.built {
            self.built = true;
            if matches!(self.screen, Screen::Invite) { self.show_invite(root) } else { self.show_list(root) }
        }
        if matches!(*a, Async::Back) {
            if matches!(self.screen, Screen::List { .. }) {
                crate::to_background();
            } else {
                self.show_list(root);
            }
            return;
        }
        if matches!(*a, Async::Log) {
            let t = crate::log_text();
            root.edit_widget_with_tag(LOG, |mut l| Label::set_text(&mut l, t));
            return;
        }
        match (*a, &self.screen) {
            (Async::ScrollBottom, Screen::Chat { tags, .. }) => {
                root.edit_widget_with_tag(tags.msgs, |mut p| {
                    Portal::set_viewport_pos(&mut p, Point::new(0.0, f64::MAX / 4.0));
                });
            }
            (Async::Core(Change::Chatlist), Screen::List { .. }) => self.show_list(root),
            (Async::Core(Change::Chatlist), Screen::Invite) => {
                if self.core.chats().map(|r| r.len()).unwrap_or(0) > 2 { self.show_list(root) } else { self.show_invite(root) }
            }
            (Async::Core(Change::Chat(c)), Screen::Chat { id, .. }) if c == *id => {
                let id = *id;
                self.refresh_chat(root, id)
            }
            _ => {}
        }
    }
}

/// `event_loop` is a builder so the Android entry can attach its `AndroidApp` first.
pub fn run(core: Core, started: Instant, mut event_loop: masonry_winit::app::EventLoopBuilder) -> anyhow::Result<()> {
    let event_loop = event_loop.build()?;
    let proxy = event_loop.create_proxy();
    let window = WindowId::next();

    crate::say(format!("renderer: {}", if cfg!(feature = "hybrid") { "vello_hybrid" } else { "vello (gpu)" }));
    // Refresh the log strip twice a second for the first minute.
    let log_proxy = proxy.clone();
    std::thread::spawn(move || {
        for _ in 0..120 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if log_proxy.send_event(MasonryUserEvent::AsyncAction(window, Box::new(Async::Log))).is_err() {
                break;
            }
        }
    });
    let notify_proxy = proxy.clone();
    core.listen(move |c| {
        let _ = notify_proxy.send_event(MasonryUserEvent::AsyncAction(window, Box::new(Async::Core(c))));
    });

    let back = NewWidget::new(Button::with_text(" ")).with_tag(BACK)
        .with_props(PropertySet::new().with(Background::Color(SURFACE)));
    let invite = NewWidget::new(Button::with_text("Invite")).with_tag(INVITE)
        .with_props(PropertySet::new().with(Background::Color(SURFACE)));
    let title = NewWidget::new(Label::new("Chats").with_style(StyleProperty::FontSize(19.0))).with_tag(TITLE)
        .with_props(PropertySet::new().with(ContentColor::new(TEXT)).with(LineBreaking::Clip));
    let header = NewWidget::new(
        Flex::row().cross_axis_alignment(CrossAxisAlignment::Center).with_fixed(back).with_fixed_spacer(px(8.0)).with(title, 1.0).with_fixed(invite),
    )
    .with_props(PropertySet::new().with(Padding::all(px(8.0))).with(Background::Color(SURFACE)));
    let body = NewWidget::new(SizedBox::empty()).with_tag(BODY);
    let log = NewWidget::new(Label::new(crate::log_text()).with_style(StyleProperty::FontSize(11.0))).with_tag(LOG)
        .with_props(PropertySet::new().with(ContentColor::new(MUTED)).with(LineBreaking::WordWrap).with(Padding { top: px(if cfg!(target_os = "android") { 36.0 } else { 4.0 }), bottom: px(4.0), left: px(8.0), right: px(8.0) }));
    let root = Flex::column().cross_axis_alignment(CrossAxisAlignment::Stretch).with_fixed(log).with_fixed(header).with(body, 1.0);

    let mut driver = Driver { core, window, proxy, screen: Screen::List { rows: vec![] }, started: Some(started), built: false };
    // First content arrives as an async refresh so the window paints immediately.
    driver.post(Async::Core(Change::Chatlist));
    if !driver.core.is_configured() {
        driver.screen = Screen::Invite;
    }

    let attrs = Window::default_attributes().with_title("Velta preview").with_inner_size(LogicalSize::new(420.0, 820.0));
    let windows = vec![NewWindow::new_with_id(window, attrs, NewWidget::new(root).erased()).with_base_color(BG)];
    let _ = masonry::app::try_init_tracing();
    let mut app = App { state: MasonryState::new(event_loop.create_proxy(), windows, default_property_set()), driver };
    event_loop.run_app(&mut app)?;
    Ok(())
}

/// Masonry's own event loop handler, plus the Back key: winit marks every key as handled
/// on Android, so without this Back does nothing.
struct App {
    state: MasonryState,
    driver: Driver,
}

impl ApplicationHandler<MasonryUserEvent> for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        self.state.handle_resumed(el, &mut self.driver);
    }
    fn suspended(&mut self, el: &ActiveEventLoop) {
        self.state.handle_suspended(el);
    }
    fn window_event(&mut self, el: &ActiveEventLoop, id: masonry_winit::winit::window::WindowId, event: WindowEvent) {
        if let WindowEvent::KeyboardInput { event: k, .. } = &event {
            if k.state == ElementState::Pressed && matches!(k.logical_key, Key::Named(NamedKey::BrowserBack | NamedKey::Escape)) {
                self.driver.post(Async::Back);
                return;
            }
        }
        self.state.handle_window_event(el, id, event, &mut self.driver);
    }
    fn device_event(&mut self, el: &ActiveEventLoop, id: DeviceId, event: DeviceEvent) {
        self.state.handle_device_event(el, id, event, &mut self.driver);
    }
    fn user_event(&mut self, el: &ActiveEventLoop, event: MasonryUserEvent) {
        self.state.handle_user_event(el, event, &mut self.driver);
    }
    fn about_to_wait(&mut self, el: &ActiveEventLoop) {
        self.state.handle_about_to_wait(el);
    }
    fn new_events(&mut self, el: &ActiveEventLoop, cause: StartCause) {
        self.state.handle_new_events(el, cause);
    }
    fn exiting(&mut self, el: &ActiveEventLoop) {
        self.state.handle_exiting(el);
    }
    fn memory_warning(&mut self, el: &ActiveEventLoop) {
        self.state.handle_memory_warning(el);
    }
}

/// Invite link as a black-on-white QR bitmap, 8 px per module with a 4-module border.
fn qr_image(text: &str) -> ImageData {
    use qrcodegen::{QrCode, QrCodeEcc};
    let qr = QrCode::encode_text(text, QrCodeEcc::Medium).expect("invite fits in a QR code");
    let (scale, border) = (8, 4);
    let n = (qr.size() + 2 * border) * scale;
    let mut data = Vec::with_capacity((n * n * 4) as usize);
    for y in 0..n {
        for x in 0..n {
            let dark = qr.get_module(x / scale - border, y / scale - border);
            let v = if dark { 0 } else { 255 };
            data.extend_from_slice(&[v, v, v, 255]);
        }
    }
    ImageData { data: data.into(), format: ImageFormat::Rgba8, alpha_type: ImageAlphaType::Alpha, width: n as u32, height: n as u32 }
}
