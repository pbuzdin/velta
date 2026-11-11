//! Screens: chat list, chat view, add-by-link and my QR, swapped inside one body
//! slot. All but the chat view carry the bottom action bar.

use std::time::Instant;

use deltachat::chat::ChatId;
use deltachat::message::MsgId;
use masonry::app::RenderRoot;
use masonry::core::{ErasedAction, NewWidget, PropertySet, StyleProperty, WidgetId, WidgetTag};
use masonry::dpi::LogicalSize;
use masonry::kurbo::{Affine, Point, Rect, Vec2};
use masonry::layout::Length;
use masonry::peniko::color::AlphaColor;
use masonry::properties::types::{CrossAxisAlignment, MainAxisAlignment};
use masonry::properties::{Background, CaretColor, ContentColor, CornerRadius, LineBreaking, Padding};
use masonry::theme::default_property_set;
use masonry::peniko::{ImageAlphaType, ImageData, ImageFormat};
use masonry::widgets::{Button, ButtonPress, Flex, Image, InsertNewline, Label, Portal, SizedBox, TextAction, TextArea};
use masonry_winit::app::{AppDriver, DriverCtx, EventLoopProxy, MasonryUserEvent, NewWindow, WindowId};
use masonry_winit::app::MasonryState;
use masonry_winit::winit::application::ApplicationHandler;
use masonry_winit::winit::event::{DeviceEvent, DeviceId, ElementState, StartCause, TouchPhase, WindowEvent};
use masonry_winit::winit::event_loop::ActiveEventLoop;
use masonry_winit::winit::keyboard::{Key, NamedKey};
use masonry_winit::winit::window::Window;

use crate::core::{Change, Core, Item, LinkDone};

const BG: AlphaColor<masonry::peniko::color::Srgb> = AlphaColor::from_rgb8(0x10, 0x12, 0x17);
const SURFACE: AlphaColor<masonry::peniko::color::Srgb> = AlphaColor::from_rgb8(0x1c, 0x1f, 0x26);
const OUT: AlphaColor<masonry::peniko::color::Srgb> = AlphaColor::from_rgb8(0x2f, 0x4a, 0x9e);
const TEXT: AlphaColor<masonry::peniko::color::Srgb> = AlphaColor::from_rgb8(0xf2, 0xf4, 0xf8);
const MUTED: AlphaColor<masonry::peniko::color::Srgb> = AlphaColor::from_rgb8(0xb4, 0xba, 0xc6);

const BODY: WidgetTag<SizedBox> = WidgetTag::named("body");
const TITLE: WidgetTag<Label> = WidgetTag::named("title");
const BACK: WidgetTag<Button> = WidgetTag::named("back");
const LOG: WidgetTag<Label> = WidgetTag::named("log");
// Masonry never drops a tag when its widget is removed, so widgets that get rebuilt
// (the chat screen) take a fresh unique tag each time instead of a named one.
struct ChatTags {
    send: WidgetTag<Button>,
    input: WidgetTag<TextArea<true>>,
    msgs: WidgetTag<Portal<Flex>>,
    /// Grows by the soft keyboard height so the composer rides above it
    /// (GameActivity ignores adjustResize; the layout does the padding).
    spacer: WidgetTag<SizedBox>,
    /// Slot above the composer for the "Reply to" banner.
    reply: WidgetTag<SizedBox>,
}

/// A finger on the screen. Mirrors Velta's touch gestures (chat-view.js):
/// direction locks after 12 px; a left drag anywhere in a chat goes back
/// (commit at min(72 px, 28% width)); a right drag on a bubble replies
/// (follows the finger up to 64 px, commit at 48 px). Positions are logical px.
struct Gesture {
    x0: f64,
    y0: f64,
    last_y: f64,
    dx: f64,
    mode: Mode,
    /// Bubble under the finger at touch start (chat screen only).
    bubble: Option<(WidgetTag<Flex>, MsgId)>,
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Undecided,
    Pan,
    Back,
    Reply,
}

/// Bottom action bar, rebuilt with each screen that shows it.
struct BarTags {
    chats: WidgetTag<Button>,
    add: WidgetTag<Button>,
    qr: WidgetTag<Button>,
}

#[derive(Clone, Copy, PartialEq)]
enum Tab {
    Chats,
    Add,
    Qr,
}

/// "Add by link": one field for every link Velta understands (relay, invite,
/// proxy); the field sits on top so the keyboard never covers it.
struct AddTags {
    input: WidgetTag<TextArea<true>>,
    go: WidgetTag<Button>,
    /// "Create account" on the default relay; only shown with no account yet.
    create: WidgetTag<Button>,
    status: WidgetTag<Label>,
}

// Floating capsule stays clear of Android's system gesture strip.
const BAR_HEIGHT: f64 = 64.0;
fn bar_bottom() -> f64 { if cfg!(target_os = "android") { 28.0 } else { 12.0 } }
fn bar_space() -> f64 { BAR_HEIGHT + bar_bottom() + 12.0 }
struct BarLayer { tag: WidgetTag<SizedBox>, id: WidgetId, rect: Rect }

const LIMIT: usize = 200;

#[derive(Debug)]
enum Async {
    Log,
    /// The phone's Back button (Escape on desktop).
    Back,
    Core(Change),
    ScrollBottom,
    /// Soft keyboard bottom inset changed (logical px).
    Insets(f64),
    /// Soft-keyboard buffer changed (GameActivity; see `crate::ime_text`).
    ImeText(String),
    /// Raw touch (physical px). Masonry's Portal has no touch drag-to-pan at
    /// this rev and no swipe gestures, so the driver does both (see Gesture).
    Touch(TouchPhase, f64, f64),
    /// A pasted link finished (core works in the background).
    Link(Result<LinkDone, String>),
}

enum Screen {
    List { rows: Vec<(WidgetTag<Button>, ChatId)>, portal: WidgetTag<Portal<Flex>>, bar: BarTags },
    Chat { id: ChatId, draft: String, tags: ChatTags, bubbles: Vec<(WidgetTag<Flex>, MsgId)>, reply: Option<(MsgId, WidgetTag<Button>)> },
    /// `busy`: a link is being used; further taps are ignored until it ends.
    Add { draft: String, tags: AddTags, bar: BarTags, busy: bool },
    /// `ready`: the QR was shown; until then list changes rebuild the screen
    /// so the QR appears once the account is ready.
    Qr { ready: bool, bar: BarTags },
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
    /// Soft keyboard height (logical px); pads the composer via `ChatTags::spacer`.
    ime: f64,
    gesture: Option<Gesture>,
    bar_layer: Option<BarLayer>,
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

    fn bar(active: Tab) -> (NewWidget<Flex>, BarTags) {
        let tags = BarTags { chats: WidgetTag::unique(), add: WidgetTag::unique(), qr: WidgetTag::unique() };
        let item = |text: &str, tab: Tab, tag: WidgetTag<Button>| {
            NewWidget::new(Button::new(NewWidget::new(Label::new(text.to_string()).with_style(StyleProperty::FontSize(15.0)))))
                .with_tag(tag)
                .with_props(
                    PropertySet::new()
                        .with(ContentColor::new(TEXT))
                        .with(Background::Color(if tab == active { OUT } else { AlphaColor::TRANSPARENT }))
                        .with(CornerRadius::all(px(18.0)))
                        .with(Padding::from_vh(px(10.0), px(8.0))),
                )
        };
        let row = Flex::row()
            .cross_axis_alignment(CrossAxisAlignment::Center)
            .with(item("Chats", Tab::Chats, tags.chats), 1.0)
            .with_fixed_spacer(px(6.0))
            .with(item("Add by link", Tab::Add, tags.add), 1.0)
            .with_fixed_spacer(px(6.0))
            .with(item("My QR", Tab::Qr, tags.qr), 1.0);
        let bar = NewWidget::new(row).with_props(
            PropertySet::new()
                .with(Padding::all(px(10.0)))
                .with(CornerRadius::all(px(28.0)))
                .with(Background::Color(if cfg!(feature = "glass") { AlphaColor::TRANSPARENT } else { SURFACE.with_alpha(0.94) })),
        );
        (bar, tags)
    }

    fn clear_bar(&mut self, root: &mut RenderRoot) {
        if let Some(layer) = self.bar_layer.take() { root.remove_layer(layer.id); }
        #[cfg(feature = "glass")]
        masonry_winit::glass::set_rects(vec![]);
    }

    fn bar_rect(root: &RenderRoot) -> Rect {
        let size = root.size().to_logical::<f64>(root.scale_factor());
        let width = (size.width - 24.0).max(1.0);
        let y = (size.height - bar_bottom() - BAR_HEIGHT).max(0.0);
        Rect::new(12.0, y, 12.0 + width, y + BAR_HEIGHT)
    }

    /// Overlay participates in Masonry hit-testing, but is painted after refraction.
    fn set_body_with_bar<W: masonry::core::Widget>(&mut self, root: &mut RenderRoot, content: NewWidget<W>, bar: NewWidget<Flex>) {
        self.clear_bar(root);
        root.edit_widget_with_tag(BODY, |mut b| SizedBox::set_child(&mut b, content));
        let rect = Self::bar_rect(root);
        let tag = WidgetTag::unique();
        let layer = NewWidget::new(SizedBox::new(bar).size(px(rect.width()), px(rect.height()))).with_tag(tag);
        let id = layer.id();
        root.add_layer(layer, rect.origin());
        self.bar_layer = Some(BarLayer { tag, id, rect });
        self.layout_bar(root);
    }

    /// Called before each redraw, including after resize / DPI changes; no timer.
    fn layout_bar(&mut self, root: &mut RenderRoot) {
        let rect = Self::bar_rect(root);
        let Some(layer) = &mut self.bar_layer else { return };
        if layer.rect != rect {
            root.edit_widget_with_tag(layer.tag, |mut b| {
                SizedBox::set_width(&mut b, px(rect.width()));
                SizedBox::set_height(&mut b, px(rect.height()));
            });
            root.reposition_layer(layer.id, rect.origin());
            layer.rect = rect;
        }
        #[cfg(feature = "glass")]
        masonry_winit::glass::set_rects(vec![masonry_winit::glass::GlassRect { rect, radius: 28.0, strength: 10.0 }]);
    }

    fn bar_hit(&self, root: &RenderRoot, is: &dyn Fn(&RenderRoot, WidgetTag<Button>) -> bool) -> Option<Tab> {
        let bar = match &self.screen {
            Screen::List { bar, .. } | Screen::Add { bar, .. } | Screen::Qr { bar, .. } => bar,
            Screen::Chat { .. } => return None,
        };
        [(bar.chats, Tab::Chats), (bar.add, Tab::Add), (bar.qr, Tab::Qr)].into_iter().find(|(t, _)| is(root, *t)).map(|(_, tab)| tab)
    }

    fn show_list(&mut self, root: &mut RenderRoot) {
        crate::set_ime_polling(false);
        self.ime = 0.0;
        let t = Instant::now();
        let rows = self.core.chats().unwrap_or_default();
        let mut col = Flex::column().cross_axis_alignment(CrossAxisAlignment::Stretch);
        let mut map = Vec::with_capacity(rows.len());
        for r in &rows {
            let tag = WidgetTag::unique();
            let top = Flex::row()
                .cross_axis_alignment(CrossAxisAlignment::Center)
                .with(label(short(&r.name, 26), 17.0, TEXT), 1.0)
                .with_fixed_spacer(px(8.0))
                .with_fixed(one_line(r.time.clone(), 13.0, MUTED));
            // Flexible children keep long names and summaries inside the row width.
            let mut bottom = Flex::row().cross_axis_alignment(CrossAxisAlignment::Center).with(label(short(&r.summary.replace('\n', " "), 34), 14.0, MUTED), 1.0);
            if r.unread > 0 {
                let pill = one_line(r.unread.to_string(), 12.0, TEXT).with_props(
                    PropertySet::new()
                        .with(ContentColor::new(TEXT))
                        .with(Background::Color(OUT))
                        .with(CornerRadius::all(px(10.0)))
                        .with(Padding::from_vh(px(2.0), px(7.0))),
                );
                bottom = bottom.with_fixed_spacer(px(8.0)).with_fixed(pill);
            }
            let body = Flex::column()
                .cross_axis_alignment(CrossAxisAlignment::Stretch)
                .with_fixed(NewWidget::new(top))
                .with_fixed(NewWidget::new(bottom));
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
        col = col.with_fixed_spacer(px(bar_space()));
        let portal_tag = WidgetTag::unique();
        let portal = NewWidget::new(Portal::new(NewWidget::new(col)).constrain_horizontal(true)).with_tag(portal_tag);
        let (bar, bar_tags) = Self::bar(Tab::Chats);
        if rows.is_empty() {
            let hint = label("No chats yet. Tap Add by link to paste an invite, or show My QR to a friend.", 15.0, MUTED)
                .with_props(PropertySet::new().with(ContentColor::new(MUTED)).with(LineBreaking::WordWrap).with(Padding::all(px(16.0))));
            let col = Flex::column().cross_axis_alignment(CrossAxisAlignment::Stretch).with_fixed(hint).with(portal, 1.0);
            self.set_body_with_bar(root, NewWidget::new(col), bar);
        } else {
            self.set_body_with_bar(root, portal, bar);
        }
        Self::set_title(root, "Chats", false);
        self.screen = Screen::List { rows: map, portal: portal_tag, bar: bar_tags };
        crate::say(format!("chat list ({} chats) built in {} ms", rows.len(), t.elapsed().as_millis()));
    }

    fn show_add(&mut self, root: &mut RenderRoot) {
        crate::set_ime_polling(false);
        self.ime = 0.0;
        crate::clear_ime_text();
        let configured = self.core.is_configured();
        let tags = AddTags { input: WidgetTag::unique(), go: WidgetTag::unique(), create: WidgetTag::unique(), status: WidgetTag::unique() };
        let input = NewWidget::new(TextArea::new_editable("").with_word_wrap(true))
            .with_tag(tags.input)
            .with_props(
                PropertySet::new()
                    .with(ContentColor::new(TEXT))
                    .with(CaretColor { color: TEXT })
                    .with(Padding::from_vh(px(10.0), px(12.0)))
                    .with(Background::Color(SURFACE)),
            );
        let go = NewWidget::new(Button::with_text("Use link")).with_tag(tags.go);
        let status = NewWidget::new(Label::new("").with_style(StyleProperty::FontSize(13.0)))
            .with_tag(tags.status)
            .with_props(PropertySet::new().with(ContentColor::new(MUTED)).with(LineBreaking::WordWrap));
        let intro = if configured {
            "Paste a link and tap Use link. A friend's or group invite starts a chat, a relay link (dcaccount: or dclogin:) adds a relay, and a socks5 link adds a proxy."
        } else {
            "Welcome. Paste a relay link (dcaccount: or dclogin:) to create your account, or tap Create account to use the default relay."
        };
        let mut col = Flex::column()
            .cross_axis_alignment(CrossAxisAlignment::Stretch)
            .with_fixed(label(intro, 15.0, TEXT))
            .with_fixed_spacer(px(8.0))
            .with_fixed(NewWidget::new(Flex::row().with(input, 1.0).with_fixed_spacer(px(8.0)).with_fixed(go)))
            .with_fixed_spacer(px(6.0))
            .with_fixed(status);
        if !configured {
            let host = self.core.default_relay.split_once(':').map(|(_, h)| h).unwrap_or(&self.core.default_relay).to_string();
            let create = NewWidget::new(Button::with_text(format!("Create account on {host}"))).with_tag(tags.create);
            col = col.with_fixed_spacer(px(20.0)).with_fixed(create);
        }
        let col = NewWidget::new(col).with_props(PropertySet::new().with(Padding { top: px(16.0), left: px(16.0), right: px(16.0), bottom: px(bar_space()) }));
        let (bar, bar_tags) = Self::bar(Tab::Add);
        self.set_body_with_bar(root, NewWidget::new(Portal::new(col).constrain_horizontal(true)), bar);
        Self::set_title(root, if configured { "Add by link" } else { "Welcome" }, false);
        self.screen = Screen::Add { draft: String::new(), tags, bar: bar_tags, busy: false };
    }

    fn show_qr(&mut self, root: &mut RenderRoot) {
        crate::set_ime_polling(false);
        self.ime = 0.0;
        let link = self.core.invite();
        let ready = !link.is_empty();
        let col = if !ready {
            let text = if self.core.is_configured() { "Setting up your account. The QR shows up here in a few seconds." } else { "No account yet. Create one in Add by link." };
            Flex::column().cross_axis_alignment(CrossAxisAlignment::Stretch).with_fixed(label(text, 16.0, TEXT))
        } else {
            Flex::column()
                .cross_axis_alignment(CrossAxisAlignment::Center)
                .with_fixed(label("Let a friend scan this in Velta (Add contact, then scan QR).", 15.0, TEXT))
                .with_fixed_spacer(px(16.0))
                .with_fixed(NewWidget::new(SizedBox::new(NewWidget::new(Image::new(qr_image(&link)))).size(px(300.0), px(300.0))))
                .with_fixed_spacer(px(16.0))
                .with_fixed(label(self.core.self_addr(), 13.0, MUTED))
        };
        let col = NewWidget::new(col).with_props(PropertySet::new().with(Padding { top: px(16.0), left: px(16.0), right: px(16.0), bottom: px(bar_space()) }));
        let (bar, bar_tags) = Self::bar(Tab::Qr);
        self.set_body_with_bar(root, NewWidget::new(Portal::new(col).constrain_horizontal(true)), bar);
        Self::set_title(root, "My QR", false);
        self.screen = Screen::Qr { ready, bar: bar_tags };
    }

    /// Hands the pasted link (or, with `create`, the default relay) to core.
    fn use_link(&mut self, root: &mut RenderRoot, create: bool) {
        let Screen::Add { draft, tags, busy, .. } = &mut self.screen else { return };
        if *busy {
            return;
        }
        let link = if create { self.core.default_relay.clone() } else { draft.trim().to_string() };
        let status = tags.status;
        let say = |root: &mut RenderRoot, t: &str| {
            let t = t.to_string();
            root.edit_widget_with_tag(status, |mut l| Label::set_text(&mut l, t));
        };
        if link.is_empty() {
            return say(root, "Paste a link first.");
        }
        *busy = true;
        say(root, if create { "Creating your account…" } else { "Working on it…" });
        let (proxy, window) = (self.proxy.clone(), self.window);
        self.core.use_link(&link, move |r| {
            let r = r.map_err(|e| format!("{e:#}"));
            let _ = proxy.send_event(MasonryUserEvent::AsyncAction(window, Box::new(Async::Link(r))));
        });
    }

    fn link_done(&mut self, root: &mut RenderRoot, r: Result<LinkDone, String>) {
        crate::say(format!("link: {r:?}"));
        match r {
            Ok(LinkDone::Chat(id)) => return self.show_chat(root, id),
            Ok(LinkDone::AccountCreated) => return self.show_list(root),
            _ => {}
        }
        let Screen::Add { draft, tags, busy, .. } = &mut self.screen else { return };
        *busy = false;
        let text = match r {
            Ok(LinkDone::Note(n)) => {
                draft.clear();
                let input = tags.input;
                root.edit_widget_with_tag(input, |mut i| TextArea::reset_text(&mut i, ""));
                crate::clear_ime_text();
                n.to_string()
            }
            Err(e) => format!("Couldn't use this link: {e}"),
            Ok(_) => return,
        };
        root.edit_widget_with_tag(tags.status, |mut l| Label::set_text(&mut l, text));
    }

    fn messages(&self, id: ChatId) -> (Flex, Vec<(WidgetTag<Flex>, MsgId)>) {
        let mut col = Flex::column().cross_axis_alignment(CrossAxisAlignment::Stretch);
        let mut bubbles = Vec::new();
        for it in self.core.items(id, LIMIT).unwrap_or_default() {
            match it {
                Item::Day(d) => {
                    col = col.with_fixed(NewWidget::new(
                        Flex::row().main_axis_alignment(MainAxisAlignment::Center).with_fixed(one_line(d, 12.0, MUTED)),
                    ));
                }
                Item::Msg { id: msg_id, outgoing, sender, text, time, quote } => {
                    let mut bubble = Flex::column().cross_axis_alignment(CrossAxisAlignment::Start);
                    if let Some(s) = sender {
                        bubble = bubble.with_fixed(one_line(s, 13.0, MUTED));
                    }
                    if let Some(q) = quote {
                        let q = label(short(&q.replace('\n', " "), 60), 13.0, MUTED).with_props(
                            PropertySet::new()
                                .with(ContentColor::new(MUTED))
                                .with(LineBreaking::WordWrap)
                                .with(Background::Color(BG))
                                .with(CornerRadius::all(px(8.0)))
                                .with(Padding::from_vh(px(4.0), px(8.0))),
                        );
                        bubble = bubble.with_fixed(q).with_fixed_spacer(px(4.0));
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
                    let tag = WidgetTag::unique();
                    let row = NewWidget::new(row).with_tag(tag).with_props(PropertySet::new().with(Padding::from_vh(px(3.0), px(8.0))));
                    col = col.with_fixed(row);
                    bubbles.push((tag, msg_id));
                }
            }
        }
        (col, bubbles)
    }

    fn show_chat(&mut self, root: &mut RenderRoot, id: ChatId) {
        self.clear_bar(root);
        let t = Instant::now();
        self.core.mark_seen(id);
        let tags = ChatTags { send: WidgetTag::unique(), input: WidgetTag::unique(), msgs: WidgetTag::unique(), spacer: WidgetTag::unique(), reply: WidgetTag::unique() };
        let (col, bubbles) = self.messages(id);
        let msgs = NewWidget::new(Portal::new(NewWidget::new(col)).constrain_horizontal(true)).with_tag(tags.msgs);
        // Raw editable TextArea (TextInput is single-line by design): Enter
        // inserts a newline, so the Send button is the send path. ContentColor
        // pinned so typed text stays visible on the dark surface.
        let input = NewWidget::new(
            TextArea::new_editable("")
                .with_word_wrap(true)
                .with_insert_newline(InsertNewline::OnEnter),
        )
        .with_tag(tags.input)
        .with_props(
            PropertySet::new()
                .with(ContentColor::new(TEXT))
                .with(CaretColor { color: TEXT })
                .with(Padding::from_vh(px(10.0), px(12.0)))
                .with(Background::Color(SURFACE)),
        );
        let send = NewWidget::new(Button::with_text("Send")).with_tag(tags.send);
        let composer = NewWidget::new(Flex::row().with(input, 1.0).with_fixed_spacer(px(8.0)).with_fixed(send))
            .with_props(
                PropertySet::new()
                    // Android draws edge to edge; keep the composer above the gesture bar.
                    .with(Padding { top: px(8.0), left: px(8.0), right: px(8.0), bottom: px(if cfg!(target_os = "android") { 28.0 } else { 8.0 }) })
                    .with(Background::Color(SURFACE)),
            );
        let spacer = NewWidget::new(SizedBox::empty().height(px(self.ime))).with_tag(tags.spacer);
        let screen = Flex::column()
            .cross_axis_alignment(CrossAxisAlignment::Stretch)
            .with(msgs, 1.0)
            .with_fixed(NewWidget::new(SizedBox::empty()).with_tag(tags.reply))
            .with_fixed(composer)
            .with_fixed(spacer);
        root.edit_widget_with_tag(BODY, |mut b| SizedBox::set_child(&mut b, NewWidget::new(screen)));
        Self::set_title(root, &self.core.chat_name(id), true);
        self.screen = Screen::Chat { id, draft: String::new(), tags, bubbles, reply: None };
        crate::clear_ime_text();
        crate::set_ime_polling(true);
        self.post(Async::ScrollBottom);
        crate::say(format!("chat {id} built in {} ms", t.elapsed().as_millis()));
    }

    fn refresh_chat(&mut self, root: &mut RenderRoot, id: ChatId) {
        let (col, list) = self.messages(id);
        let Screen::Chat { tags, bubbles, .. } = &mut self.screen else { return };
        *bubbles = list;
        let msgs = tags.msgs;
        root.edit_widget_with_tag(msgs, |mut p| Portal::set_child(&mut p, NewWidget::new(col)));
        self.post(Async::ScrollBottom);
    }

    fn send(&mut self, root: &mut RenderRoot) {
        let Screen::Chat { id, draft, tags, reply, .. } = &mut self.screen else { return };
        let text = std::mem::take(draft);
        if text.trim().is_empty() {
            return;
        }
        let (id, input, quote) = (*id, tags.input, reply.map(|(m, _)| m));
        if let Err(e) = self.core.send_text(id, text, quote) {
            crate::say(format!("send failed: {e:#}"));
        }
        self.clear_reply(root);
        root.edit_widget_with_tag(input, |mut i| TextArea::reset_text(&mut i, ""));
        crate::clear_ime_text();
        self.refresh_chat(root, id);
    }
}

impl Driver {
    fn set_reply(&mut self, root: &mut RenderRoot, msg: MsgId) {
        let text = short(&self.core.msg_text(msg).replace('\n', " "), 40);
        let Screen::Chat { tags, reply, .. } = &mut self.screen else { return };
        let cancel = WidgetTag::unique();
        let banner = Flex::row()
            .cross_axis_alignment(CrossAxisAlignment::Center)
            .with(label(format!("Reply to: {text}"), 14.0, MUTED), 1.0)
            .with_fixed_spacer(px(8.0))
            .with_fixed(NewWidget::new(Button::with_text("Cancel")).with_tag(cancel));
        let banner = NewWidget::new(banner).with_props(
            PropertySet::new().with(Background::Color(SURFACE)).with(Padding { top: px(8.0), bottom: px(0.0), left: px(12.0), right: px(8.0) }),
        );
        root.edit_widget_with_tag(tags.reply, |mut b| SizedBox::set_child(&mut b, banner));
        *reply = Some((msg, cancel));
    }

    fn clear_reply(&mut self, root: &mut RenderRoot) {
        let Screen::Chat { tags, reply, .. } = &mut self.screen else { return };
        if reply.take().is_some() {
            root.edit_widget_with_tag(tags.reply, |mut b| SizedBox::remove_child(&mut b));
        }
    }

    fn touch(&mut self, root: &mut RenderRoot, phase: TouchPhase, x: f64, y: f64) {
        let scale = root.scale_factor();
        let (x, y) = (x / scale, y / scale);
        match phase {
            TouchPhase::Started => {
                // A drag on the floating controls must not scroll content underneath.
                if self.bar_layer.as_ref().is_some_and(|b| b.rect.contains(Point::new(x, y))) {
                    self.gesture = None;
                    return;
                }
                let (mode, bubble) = match &self.screen {
                    Screen::Chat { bubbles, .. } => {
                        let p = Point::new(x, y);
                        let hit = bubbles
                            .iter()
                            .find(|(t, _)| root.get_widget_with_tag(*t).is_some_and(|w| w.ctx().bounding_box().contains(p)))
                            .copied();
                        (Mode::Undecided, hit)
                    }
                    _ => (Mode::Pan, None),
                };
                self.gesture = Some(Gesture { x0: x, y0: y, last_y: y, dx: 0.0, mode, bubble });
            }
            TouchPhase::Moved => {
                let Some(g) = &mut self.gesture else { return };
                let (dx, dy) = (x - g.x0, y - g.y0);
                if g.mode == Mode::Undecided {
                    g.mode = if dy.abs() > 12.0 && dy.abs() >= dx.abs() {
                        Mode::Pan
                    } else if dx < -12.0 && dx.abs() >= dy.abs() {
                        Mode::Back
                    } else if dx > 12.0 && dx.abs() >= dy.abs() && g.bubble.is_some() {
                        Mode::Reply
                    } else {
                        return;
                    };
                }
                match g.mode {
                    Mode::Pan => {
                        let d = g.last_y - y;
                        g.last_y = y;
                        let tag = match &self.screen {
                            Screen::Chat { tags, .. } => Some(tags.msgs),
                            Screen::List { portal, .. } => Some(*portal),
                            Screen::Add { .. } | Screen::Qr { .. } => None,
                        };
                        if let Some(tag) = tag {
                            root.edit_widget_with_tag(tag, |mut p| Portal::pan_viewport_by(&mut p, Vec2::new(0.0, d)));
                        }
                    }
                    Mode::Back => {
                        g.dx = dx.min(0.0);
                        let t = Affine::translate((g.dx, 0.0));
                        root.edit_widget_with_tag(BODY, |mut b| b.set_transform(t));
                    }
                    Mode::Reply => {
                        g.dx = dx.clamp(0.0, 64.0);
                        let t = Affine::translate((g.dx, 0.0));
                        if let Some((tag, _)) = g.bubble {
                            root.edit_widget_with_tag(tag, |mut b| b.set_transform(t));
                        }
                    }
                    Mode::Undecided => {}
                }
            }
            TouchPhase::Ended | TouchPhase::Cancelled => {
                let Some(g) = self.gesture.take() else { return };
                let commit = phase == TouchPhase::Ended;
                match g.mode {
                    Mode::Back => {
                        let width = root.get_widget_with_tag(BODY).map(|w| w.ctx().bounding_box().width()).unwrap_or(320.0);
                        root.edit_widget_with_tag(BODY, |mut b| b.set_transform(Affine::IDENTITY));
                        if commit && g.dx <= -(72.0f64).min(width * 0.28) {
                            self.show_list(root);
                        }
                    }
                    Mode::Reply => {
                        if let Some((tag, msg)) = g.bubble {
                            root.edit_widget_with_tag(tag, |mut b| b.set_transform(Affine::IDENTITY));
                            if commit && g.dx >= 48.0 {
                                self.set_reply(root, msg);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
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
            } else if let Some(tab) = self.bar_hit(root, &is) {
                match tab {
                    Tab::Chats => self.show_list(root),
                    Tab::Add => self.show_add(root),
                    Tab::Qr => self.show_qr(root),
                }
            } else if matches!(&self.screen, Screen::Chat { tags, .. } if is(root, tags.send)) {
                self.send(root);
            } else if matches!(&self.screen, Screen::Chat { reply: Some((_, c)), .. } if is(root, *c)) {
                self.clear_reply(root);
            } else if matches!(&self.screen, Screen::Add { tags, .. } if is(root, tags.go)) {
                self.use_link(root, false);
            } else if matches!(&self.screen, Screen::Add { tags, .. } if is(root, tags.create)) {
                self.use_link(root, true);
            } else if let Screen::List { rows, .. } = &self.screen {
                let hit = rows.iter().find(|(tag, _)| is(root, *tag)).map(|(_, id)| *id);
                if let Some(id) = hit {
                    self.show_chat(root, id);
                }
            }
        } else if action.is::<TextAction>() {
            match *action.downcast::<TextAction>().unwrap() {
                TextAction::Changed(t) => match &mut self.screen {
                    Screen::Chat { draft, .. } | Screen::Add { draft, .. } => *draft = t,
                    Screen::List { .. } | Screen::Qr { .. } => {}
                },
                TextAction::Entered(_) => {
                    if matches!(self.screen, Screen::Add { .. }) { self.use_link(root, false) } else { self.send(root) }
                }
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
            if matches!(self.screen, Screen::Add { .. }) { self.show_add(root) } else { self.show_list(root) }
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
        if let Async::ImeText(t) = &*a {
            let (draft, input) = match &mut self.screen {
                Screen::Chat { draft, tags, .. } => (draft, tags.input),
                Screen::Add { draft, tags, .. } => (draft, tags.input),
                Screen::List { .. } | Screen::Qr { .. } => return,
            };
            if *draft != *t {
                *draft = t.clone();
                root.edit_widget_with_tag(input, |mut i| TextArea::reset_text(&mut i, t));
            }
            return;
        }
        if let Async::Insets(v) = *a {
            self.ime = v;
            if let Screen::Chat { tags, .. } = &self.screen {
                root.edit_widget_with_tag(tags.spacer, |mut s| SizedBox::set_height(&mut s, px(v)));
            }
            return;
        }
        let a = match *a {
            Async::Link(r) => return self.link_done(root, r),
            other => other,
        };
        if let Async::Touch(phase, x, y) = a {
            return self.touch(root, phase, x, y);
        }
        match (a, &self.screen) {
            (Async::ScrollBottom, Screen::Chat { tags, .. }) => {
                root.edit_widget_with_tag(tags.msgs, |mut p| {
                    Portal::set_viewport_pos(&mut p, Point::new(0.0, f64::MAX / 4.0));
                });
            }
            (Async::Core(Change::Chatlist), Screen::List { .. }) => self.show_list(root),
            // Until the account is ready, rebuild so the QR appears.
            (Async::Core(Change::Chatlist), Screen::Qr { ready: false, .. }) => self.show_qr(root),
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

    // Track the soft keyboard: GameActivity ignores adjustResize, so the UI pads
    // its composer by the IME inset itself. The poller only runs while a chat is
    // open and the app is in the foreground (battery); otherwise it parks.
    #[cfg(target_os = "android")]
    {
        let ime_proxy = proxy.clone();
        std::thread::spawn(move || {
            let mut last = 0.0_f64;
            loop {
                if crate::ime_poll_wait() {
                    last = -1.0;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
                let v = crate::ime_bottom();
                if (v - last).abs() > 0.5 {
                    last = v;
                    if ime_proxy.send_event(MasonryUserEvent::AsyncAction(window, Box::new(Async::Insets(v)))).is_err() {
                        break;
                    }
                }
            }
        });
    }

    let back = NewWidget::new(Button::with_text(" ")).with_tag(BACK)
        .with_props(PropertySet::new().with(Background::Color(SURFACE)));
    let title = NewWidget::new(Label::new("Chats").with_style(StyleProperty::FontSize(19.0))).with_tag(TITLE)
        .with_props(PropertySet::new().with(ContentColor::new(TEXT)).with(LineBreaking::Clip));
    let header = NewWidget::new(
        Flex::row().cross_axis_alignment(CrossAxisAlignment::Center).with_fixed(back).with_fixed_spacer(px(8.0)).with(title, 1.0),
    )
    .with_props(PropertySet::new().with(Padding::all(px(8.0))).with(Background::Color(SURFACE)));
    let body = NewWidget::new(SizedBox::empty()).with_tag(BODY);
    let log = NewWidget::new(Label::new(crate::log_text()).with_style(StyleProperty::FontSize(11.0))).with_tag(LOG)
        .with_props(PropertySet::new().with(ContentColor::new(MUTED)).with(LineBreaking::WordWrap).with(Padding { top: px(if cfg!(target_os = "android") { 36.0 } else { 4.0 }), bottom: px(4.0), left: px(8.0), right: px(8.0) }));
    let root = Flex::column().cross_axis_alignment(CrossAxisAlignment::Stretch).with_fixed(log).with_fixed(header).with(body, 1.0);

    let mut driver = Driver { core, window, proxy, screen: Screen::List { rows: vec![], portal: WidgetTag::unique(), bar: BarTags { chats: WidgetTag::unique(), add: WidgetTag::unique(), qr: WidgetTag::unique() } }, started: Some(started), built: false, ime: 0.0, gesture: None, bar_layer: None };
    // First content arrives as an async refresh so the window paints immediately.
    driver.post(Async::Core(Change::Chatlist));
    if !driver.core.is_configured() {
        // Placeholder until the first build; show_add makes the real one.
        let tags = AddTags { input: WidgetTag::unique(), go: WidgetTag::unique(), create: WidgetTag::unique(), status: WidgetTag::unique() };
        let bar = BarTags { chats: WidgetTag::unique(), add: WidgetTag::unique(), qr: WidgetTag::unique() };
        driver.screen = Screen::Add { draft: String::new(), tags, bar, busy: false };
    }

    let attrs = Window::default_attributes().with_title("Velta preview").with_inner_size(LogicalSize::new(420.0, 820.0));
    let windows = vec![NewWindow::new_with_id(window, attrs, NewWidget::new(root).erased()).with_base_color(BG)];
    let _ = masonry::app::try_init_tracing();
    let mut app = App { state: MasonryState::new(event_loop.create_proxy(), windows, default_property_set()), driver, ime_text: String::new() };
    event_loop.run_app(&mut app)?;
    Ok(())
}

/// Masonry's own event loop handler, plus the Back key: winit marks every key as handled
/// on Android, so without this Back does nothing. Also forwards raw touches to the
/// driver's gesture handling (scroll, swipe back, swipe to reply); Masonry's
/// Portal only pans on wheel events, not finger drags.
struct App {
    state: MasonryState,
    driver: Driver,
    /// Last soft-keyboard buffer mirrored into the composer.
    ime_text: String,
}

impl ApplicationHandler<MasonryUserEvent> for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        self.state.handle_resumed(el, &mut self.driver);
        crate::set_ime_polling(matches!(self.driver.screen, Screen::Chat { .. }));
    }
    fn suspended(&mut self, el: &ActiveEventLoop) {
        crate::set_ime_polling(false);
        self.state.handle_suspended(el);
        // A finger lifted while backgrounded never reports Ended; settle any swipe.
        self.driver.post(Async::Touch(TouchPhase::Cancelled, 0.0, 0.0));
    }
    fn window_event(&mut self, el: &ActiveEventLoop, id: masonry_winit::winit::window::WindowId, event: WindowEvent) {
        if let WindowEvent::KeyboardInput { event: k, .. } = &event {
            if k.state == ElementState::Pressed && matches!(k.logical_key, Key::Named(NamedKey::BrowserBack | NamedKey::Escape)) {
                self.driver.post(Async::Back);
                return;
            }
            // GameActivity: the keyboard buffer is the only source of composer
            // text; letting key events into the TextArea too would double edits.
            if cfg!(all(target_os = "android", feature = "game-activity")) {
                return;
            }
        }
        if let WindowEvent::Touch(t) = &event {
            self.driver.post(Async::Touch(t.phase, t.location.x, t.location.y));
        }
        if matches!(event, WindowEvent::RedrawRequested) {
            for root in self.state.roots() { self.driver.layout_bar(root); }
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
        if matches!(self.driver.screen, Screen::Chat { .. } | Screen::Add { .. })
            && let Some(t) = crate::ime_text()
            && t != self.ime_text
        {
            self.ime_text = t.clone();
            self.driver.post(Async::ImeText(t));
        }
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

/// Masonry measures clipped labels at their full text width, which pushes chat rows past
/// the screen edge. Wrapping labels fit, so long names and previews are shortened here.
fn short(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{}…", cut.trim_end())
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
