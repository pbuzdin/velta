//! Screens: chat list and chat view, swapped inside one body slot.

use std::time::Instant;

use deltachat::chat::ChatId;
use masonry::app::RenderRoot;
use masonry::core::{ErasedAction, NewWidget, PropertySet, StyleProperty, Widget, WidgetId, WidgetTag};
use masonry::dpi::LogicalSize;
use masonry::kurbo::Point;
use masonry::layout::Length;
use masonry::peniko::color::AlphaColor;
use masonry::properties::types::{CrossAxisAlignment, MainAxisAlignment};
use masonry::properties::{Background, ContentColor, CornerRadius, LineBreaking, Padding};
use masonry::theme::default_property_set;
use masonry::widgets::{Button, ButtonPress, Flex, Label, Portal, SizedBox, TextAction, TextArea, TextInput};
use masonry_winit::app::{AppDriver, DriverCtx, EventLoop, EventLoopProxy, MasonryUserEvent, NewWindow, WindowId};
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
const SEND: WidgetTag<Button> = WidgetTag::named("send");
const INPUT: WidgetTag<TextInput> = WidgetTag::named("input");
const MSGS: WidgetTag<Portal<Flex>> = WidgetTag::named("msgs");

const LIMIT: usize = 200;

#[derive(Debug)]
enum Async {
    Core(Change),
    ScrollBottom,
}

enum Screen {
    List { rows: Vec<(WidgetTag<Button>, ChatId)> },
    Chat { id: ChatId, draft: String },
}

struct Driver {
    core: Core,
    window: WindowId,
    proxy: EventLoopProxy,
    screen: Screen,
    started: Option<Instant>,
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
            Button::set_child(&mut b, NewWidget::new(Label::new(if back { "‹" } else { " " }).with_style(StyleProperty::FontSize(22.0))));
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
        eprintln!("velta-preview: chat list ({} chats) built in {} ms", rows.len(), t.elapsed().as_millis());
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
        let msgs = NewWidget::new(Portal::new(NewWidget::new(self.messages(id))).constrain_horizontal(true)).with_tag(MSGS);
        let input = NewWidget::new(TextInput::new("").with_placeholder("Message")).with_tag(INPUT);
        let send = NewWidget::new(Button::with_text("Send")).with_tag(SEND);
        let composer = NewWidget::new(Flex::row().with(input, 1.0).with_fixed_spacer(px(8.0)).with_fixed(send))
            .with_props(PropertySet::new().with(Padding::all(px(8.0))).with(Background::Color(SURFACE)));
        let screen = Flex::column().cross_axis_alignment(CrossAxisAlignment::Stretch).with(msgs, 1.0).with_fixed(composer);
        root.edit_widget_with_tag(BODY, |mut b| SizedBox::set_child(&mut b, NewWidget::new(screen)));
        Self::set_title(root, &self.core.chat_name(id), true);
        self.screen = Screen::Chat { id, draft: String::new() };
        self.post(Async::ScrollBottom);
        eprintln!("velta-preview: chat {id} built in {} ms", t.elapsed().as_millis());
    }

    fn refresh_chat(&mut self, root: &mut RenderRoot, id: ChatId) {
        let col = self.messages(id);
        root.edit_widget_with_tag(MSGS, |mut p| Portal::set_child(&mut p, NewWidget::new(col)));
        self.post(Async::ScrollBottom);
    }

    fn send(&mut self, root: &mut RenderRoot) {
        let Screen::Chat { id, draft } = &mut self.screen else { return };
        let text = std::mem::take(draft);
        if text.trim().is_empty() {
            return;
        }
        let id = *id;
        if let Err(e) = self.core.send_text(id, text) {
            eprintln!("velta-preview: send failed: {e:#}");
        }
        root.edit_widget_with_tag(INPUT, |mut i| TextArea::reset_text(&mut TextInput::text_mut(&mut i), ""));
        self.refresh_chat(root, id);
    }
}

impl AppDriver for Driver {
    fn on_action(&mut self, window_id: WindowId, ctx: &mut DriverCtx<'_>, widget_id: WidgetId, action: ErasedAction) {
        let root = ctx.render_root(window_id);
        if action.is::<ButtonPress>() {
            let is = |root: &RenderRoot, tag: WidgetTag<Button>| root.get_widget_with_tag(tag).map(|w| w.id()) == Some(widget_id);
            if is(root, BACK) {
                if matches!(self.screen, Screen::Chat { .. }) {
                    self.show_list(root);
                }
            } else if is(root, SEND) {
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
            eprintln!("velta-preview: first frame cycle after {} ms", started.elapsed().as_millis());
        }
        let Ok(a) = action.downcast::<Async>() else { return };
        match (*a, &self.screen) {
            (Async::ScrollBottom, Screen::Chat { .. }) => {
                root.edit_widget_with_tag(MSGS, |mut p| {
                    Portal::set_viewport_pos(&mut p, Point::new(0.0, f64::MAX / 4.0));
                });
            }
            (Async::Core(Change::Chatlist), Screen::List { .. }) => self.show_list(root),
            (Async::Core(Change::Chat(c)), Screen::Chat { id, .. }) if c == *id => {
                let id = *id;
                self.refresh_chat(root, id)
            }
            _ => {}
        }
    }
}

pub fn run(core: Core, started: Instant) -> anyhow::Result<()> {
    let event_loop = EventLoop::with_user_event().build()?;
    let proxy = event_loop.create_proxy();
    let window = WindowId::next();

    let notify_proxy = proxy.clone();
    core.listen(move |c| {
        let _ = notify_proxy.send_event(MasonryUserEvent::AsyncAction(window, Box::new(Async::Core(c))));
    });

    let back = NewWidget::new(Button::with_text(" ")).with_tag(BACK)
        .with_props(PropertySet::new().with(Background::Color(SURFACE)));
    let title = NewWidget::new(Label::new("Chats").with_style(StyleProperty::FontSize(19.0))).with_tag(TITLE)
        .with_props(PropertySet::new().with(ContentColor::new(TEXT)).with(LineBreaking::Clip));
    let header = NewWidget::new(
        Flex::row().cross_axis_alignment(CrossAxisAlignment::Center).with_fixed(back).with_fixed_spacer(px(8.0)).with(title, 1.0),
    )
    .with_props(PropertySet::new().with(Padding::all(px(8.0))).with(Background::Color(SURFACE)));
    let body = NewWidget::new(SizedBox::empty()).with_tag(BODY);
    let root = Flex::column().cross_axis_alignment(CrossAxisAlignment::Stretch).with_fixed(header).with(body, 1.0);

    let mut driver = Driver { core, window, proxy, screen: Screen::List { rows: vec![] }, started: Some(started) };
    // First content arrives as an async refresh so the window paints immediately.
    driver.post(Async::Core(Change::Chatlist));

    let attrs = Window::default_attributes().with_title("Velta preview").with_inner_size(LogicalSize::new(420.0, 820.0));
    masonry_winit::app::run_with(
        event_loop,
        vec![NewWindow::new_with_id(window, attrs, NewWidget::new(root).erased()).with_base_color(BG)],
        driver,
        default_property_set(),
    )?;
    Ok(())
}
