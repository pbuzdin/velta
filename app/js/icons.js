// Shared UI icons (docs: /workspace icon review 2026-10). One source per glyph
// so a fix lands everywhere. House style: 24x24 viewBox, outline, fill none,
// stroke currentColor, stroke-width 2, round caps + joins. Decorative by
// default (aria-hidden, focusable=false); status-only icons get a label via
// labelled(). Plain ES module (.js — see no-mjs-runtime-modules test).

const ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const DECOR = 'aria-hidden="true" focusable="false"';

/** Wrap 24-grid inner markup in the house-style <svg>. */
export function svg(inner, cls = "") {
  return `<svg${cls ? ` class="${cls}"` : ""} ${ATTRS} ${DECOR}>${inner}</svg>`;
}

/** Same glyph as a status-only image: role=img + aria-label, not hidden. */
export function labelled(icon, label) {
  return icon.replace(DECOR, `role="img" aria-label="${String(label).replace(/"/g, "&quot;")}" focusable="false"`);
}

const DOT = (cx, cy, r = 1.2) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

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
  forward: '<path d="M15 14l5-5-5-5M20 9h-9a7 7 0 00-7 7v2"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
};

export const ICON = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, svg(v)]));
export const CLOSE_SVG = ICON.close;
