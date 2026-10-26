// Shared UI icons (docs: /workspace icon review 2026-10). One source per glyph
// so a fix lands everywhere. House style: 24x24 viewBox, outline, fill none,
// stroke currentColor, stroke-width 2, round caps + joins. Decorative by
// default (aria-hidden, focusable=false); status-only icons get a label via
// labelled(). Plain ES module (.js — see no-mjs-runtime-modules test).

const ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const DECOR = 'aria-hidden="true" focusable="false"';

/** Wrap 24-grid inner markup in the house-style <svg>. `extra` = raw
 *  attributes for the few sized/styled uses (e.g. 'width="20" height="20"'). */
export function svg(inner, cls = "", extra = "") {
  return `<svg${cls ? ` class="${cls}"` : ""} ${ATTRS}${extra ? ` ${extra}` : ""} ${DECOR}>${inner}</svg>`;
}

/** Same glyph as a status-only image: role=img + aria-label, not hidden. */
export function labelled(icon, label) {
  return icon.replace(DECOR, `role="img" aria-label="${String(label).replace(/"/g, "&quot;")}" focusable="false"`);
}

const DOT = (cx, cy, r = 1.2) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

const PROFILE = '<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0116 0"/>';
const CHECK_INNER = '<path d="M8.5 12.5l2.5 2.5 5-5.5"/>';

export const P = {
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  phone: '<path d="M6.6 10.8a15.1 15.1 0 006.6 6.6l2.2-2.2a1 1 0 011-.24 11.4 11.4 0 003.6.58 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.4 11.4 0 00.57 3.6 1 1 0 01-.25 1z"/>',
  // video call: camcorder body + lens wedge (header button)
  videoCall: '<rect x="3" y="6.5" width="12.5" height="11" rx="2"/><path d="M15.5 10.5l5.5-3v9l-5.5-3z"/>',
  // video file (attach menu, video messages): frame + play triangle
  video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.2v5.6l4.6-2.8z"/>',
  camera: '<path d="M4 8h3l1.8-2.5h6.4L17 8h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"/><circle cx="12" cy="13" r="3.5"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2"/>' + DOT(9, 10, 1.6) + '<path d="M4 17l5-5 3.5 3.5L16 12l4 4"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14"/>',
  pin: '<path d="M9 3h6M10 3v6l-3.5 4v2h11v-2L14 9V3M12 15v6"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>',
  star: '<path d="M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2-5.6-3.2-5.6 3.2 1.3-6.2L3 9.5l6.3-.7z"/>',
  mute: '<path d="M12 3a5 5 0 00-5 5v3l-2 4h14l-2-4V8a5 5 0 00-5-5z"/><path d="M4 4l16 16"/>',
  bell: '<path d="M12 3a5 5 0 00-5 5v3l-2 4h14l-2-4V8a5 5 0 00-5-5z"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2m-8 0l1 13h8l1-13"/>',
  link: '<path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  tick1: '<path d="M5 13l4 4L19 7"/>',
  // double tick on the 24 grid, same stroke as tick1
  tick2: '<path d="M2 13l4 4L16 7M11.5 16.5l.5.5L22 7"/>',
  warn: '<path d="M12 4L2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  reply: '<path d="M9 14L4 9l5-5M4 9h9a7 7 0 017 7v2"/>',
  // thread: two overlapping speech bubbles (opens a message's replies)
  thread: '<path d="M14 9a2 2 0 012 2v6a2 2 0 01-2 2H7l-4 3V11a2 2 0 012-2z"/><path d="M8 9V5a2 2 0 012-2h9a2 2 0 012 2v11l-3-3h-2"/>',
  forward: '<path d="M15 14l5-5-5-5M20 9h-9a7 7 0 00-7 7v2"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  playDiag: '<path d="M8 5.2l11 6.8-11 6.8z" fill="currentColor" stroke="none"/>',
  relaySend: '<rect x="2.5" y="9.5" width="19" height="11" rx="2"/><path d="M4 11.5l8 5.5 8-5.5"/><path d="M12 12V2.6"/><path d="M8.7 5.6L12 2.2l3.3 3.4"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9M10 13h4"/>',
  markRead: '<path d="M3 13l4 4L17 7M10 15l2 2 8-8"/>',
  playFilled: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
  pauseFilled: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/>',
  gotoMessage: '<path d="M4 5h16v11H8l-4 4z"/><path d="M9 10.5h6m-2.5-2.5 2.5 2.5-2.5 2.5"/>',
  selectText: '<path d="M4 8.5h5.5M4 12h3.5M4 15.5h5.5M18 4.5v15M16 4.5h4M16 19.5h4"/>',
  selectCircle: '<circle cx="12" cy="12" r="9"/>' + CHECK_INNER,
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  fileLarge: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M10 10v6.5h4.5"/>',
  webxdc: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><path d="M17.5 13.5v6m-3-3h6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  resend: '<polyline points="2.5 5.5 2.5 11 8 11"/><path d="M4.2 14.5a8 8 0 1 0 1.5-8L2.5 10"/>',
  share: '<path d="M12 14V4m0 0L8.5 7.5M12 4l3.5 3.5"/><path d="M5 11v8a1 1 0 001 1h12a1 1 0 001-1v-8"/>',
  dotsVertical: '<circle cx="12" cy="5.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.7" fill="currentColor" stroke="none"/>',
  openLink: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h4"/>',
  avatarStar: '<path d="M12 4l2.2 4.7 5 .6-3.7 3.4 1 4.9-4.5-2.6-4.5 2.6 1-4.9L4.8 9.3l5-.6z" fill="currentColor" stroke="none"/>',
  device: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><circle cx="12" cy="17.5" r="1.2" fill="currentColor" stroke="none"/>',
  videoPlay: '<path d="M6.5 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  lockOpen: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.6-1.7"/>',
  wifi: '<path d="M2.5 9.5a14 14 0 0119 0M5.5 13a9.5 9.5 0 0113 0M8.5 16.5a5 5 0 017 0"/><circle cx="12" cy="19.5" r="1.4" fill="currentColor" stroke="none"/>',
  failedMark: '<path d="M12 4v9"/><circle cx="12" cy="18.8" r="2" fill="currentColor" stroke="none"/>',
  openExternal: '<path d="M14 4h6v6M20 4l-9 9M18 13v6a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h6"/>',
  smiley: '<circle cx="12" cy="12" r="9"/><path d="M8 14.2c1.2 1.1 2.5 1.6 4 1.6s2.8-.5 4-1.6"/><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1" fill="currentColor" stroke="none"/>',
  chatAppearance: '<path d="M4 5h16a1 1 0 011 1v9a1 1 0 01-1 1h-9l-5 4v-4H4a1 1 0 01-1-1V6a1 1 0 011-1z"/><path d="M7 9.5h7M7 12.5h4"/>',
  profile: PROFILE,
  profileAdd: PROFILE + '<path d="M19 5v4M21 7h-4"/>',
  // small check that sits inside a ring (select) or over the profile glyph (current account)
  checkInner: CHECK_INNER,
  bookmark: '<path d="M6 3h12v18l-6-4.5L6 21z"/>',
  invite: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1" fill="currentColor" stroke="none"/><rect x="3" y="13" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>',
  typing: '<rect x="3" y="6" width="18" height="12" rx="2.5"/><circle cx="8" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  palette: '<path d="M12 3a9 9 0 109 9c0-1.5-1.2-2.6-2.6-2.6h-1.9a2.5 2.5 0 01-2.5-2.5V5.1C14 4 13.3 3 12 3z"/><circle cx="7.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="16.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/>',
  language: '<path d="M4 6h16M8 12h12M4 18h16"/>',
  textSize: '<path d="M5 19L11.2 5h1.6L19 19M7.2 15h9.6"/><path d="M16.5 5.5L21 10M21 5.5L16.5 10"/>',
  barChart: '<rect x="3" y="17" width="18" height="4" rx="1"/><path d="M6 17v-4m6 4V9m6 8V5"/>',
  sortLines: '<path d="M4 6h16M4 12h10M4 18h7"/>',
  notifications: '<path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/>',
  downloadTray: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 15v4h14v-4"/>',
  downloadBar: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><rect x="4" y="17" width="16" height="4" rx="1"/>',
  wsTransport: '<path d="M4 8h14m0 0l-3-3m3 3l-3 3"/><path d="M20 16H6m0 0l3-3m-3 3l3 3"/>',
  tunnel: '<path d="M3 20V11a9 9 0 0118 0v9"/><path d="M8 20v-7a4 4 0 018 0v7"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M17 5l3 3M14 8l2.5 2.5"/>',
  cleanLink: '<path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7"/><path d="M4 20l5-5"/>',
  enterKey: '<path d="M20 5v6a2 2 0 01-2 2H5m0 0l4-4m-4 4l4 4"/>',
  devices: '<rect x="3" y="4" width="7" height="14" rx="1.5"/><rect x="14" y="6" width="7" height="14" rx="1.5"/>',
  battery: '<rect x="2.5" y="8" width="16.5" height="8" rx="1.5"/><path d="M21.5 10.5v3"/><rect x="4.5" y="10" width="3.5" height="4" rx="0.5" fill="currentColor" stroke="none"/>',
  stopSquare: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z" fill="currentColor" stroke="none"/>',
  bookmarkExport: '<path d="M6 3h12v18l-6-4.5L6 21z"/><path d="M12 7v6m0-6l-2.5 2.5M12 7l2.5 2.5"/>',
  chats: '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
  contacts: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0114 0M16 3.5a4 4 0 010 9M15.5 14a7 7 0 016.5 7"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M6.5 6.5h0M17.5 6.5h0M6.5 17.5h0M14 14h3M20 14v0M14 17.5v3.5M17.5 21h3.5M20.5 17.5h0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chatLines: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  dotsVerticalLg: '<circle cx="12" cy="5" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.8" fill="currentColor" stroke="none"/>',
  attach: '<path d="M21 12.5l-8.5 8.5a5.5 5.5 0 01-7.8-7.8l9.2-9.2a3.7 3.7 0 015.2 5.2l-9 9a1.85 1.85 0 01-2.6-2.6l8.3-8.3"/>',
  sticker: '<path d="M11.5 20H6a2 2 0 01-2-2V6a2 2 0 012-2h12a2 2 0 012 2v6.5L11.5 20Z"/><path d="M13 20a7 7 0 017-7"/><circle cx="8.7" cy="9.7" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.3" cy="9.7" r="1.15" fill="currentColor" stroke="none"/><path d="M8.5 13.4a4.2 4.2 0 007 0"/>',
  send: '<path d="M3 11.5L21 3l-6.5 18-2.7-7.3z"/>',
  // scheduled messages ("Send later"): clock face, hands at 12 → 4
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

export const ICON = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, svg(v)]));
export const CLOSE_SVG = ICON.close;
// Velta Loop mark (two arm wedges + two side arcs, the site's loop-logo.svg
// geometry). The original card icon — shared by the hub card and the drawer.
export const LOOP_SVG = `<svg viewBox="0 0 624 590" width="21" height="20" aria-hidden="true"><g fill="currentColor" transform="translate(68.6 64.9) scale(0.78)"><polygon points="0,0 191,0 402,420 314,590"/><polygon points="434,0 624,0 420,385 341,225"/></g><path d="M510,267.1 A200,200 0 0 1 386.9,480.4" fill="none" stroke="currentColor" stroke-width="40"/><path d="M114,267.1 A200,200 0 0 0 237.1,480.4" fill="none" stroke="currentColor" stroke-width="40"/></svg>`;

/** index.html is static: its icons are `<svg data-icon="name"></svg>`
 *  placeholders, filled from P here (keeps any class). */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll("svg[data-icon]")) {
    const inner = P[el.dataset.icon];
    if (inner) el.outerHTML = svg(inner, el.getAttribute("class") || "");
  }
}
if (typeof document !== "undefined" && document.querySelectorAll) hydrateIcons();
