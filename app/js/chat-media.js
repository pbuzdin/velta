// chat-media.js — the chat info view's media gallery: five native <details>
// sections (Apps, Photos, Videos, Audio, Files). Each <summary> shows a count
// from the core's gallery index (get_chat_media: message ids only, cheap);
// message bodies load lazily, in batches, the first time a section opens and
// then only for the rows/tiles in the scroll window.
//
// Plain DOM on purpose: no custom elements inside, so no Elena host re-render
// can strip a nested element's children (the empty-avatar bug of e7ecf79).
// Rows are rebuilt from data whenever they enter the window.
//
// Thumbnails use fileUrl() (blobfile / media server / asset / wasm SW URLs —
// no object URLs are created here). Off-screen tiles leave the DOM, and their
// <img> src is cleared first so the decoder releases them; if an opener ever
// hands us a blob: URL it is revoked only when its tile scrolls off-screen.
import { escapeHtml, escapeAttr, formatBytes, formatDuration, formatDateTime } from "./format.js";
import { t } from "./i18n.js";
import { foldText, virtualWindow, buildSearchRow, buildVirtualScroller } from "./member-list.js";
import { LruCache } from "./lru.js";
import { audioPlayerHtml, mountAudioPlayer, decodeAudioDuration } from "./audio-player.js";
import { P, svg } from "./icons.js";

export const MEDIA_SECTIONS = [
  { key: "apps", label: "Apps", types: ["Webxdc"], layout: "list", search: "Search apps", empty: "No apps found" },
  { key: "photos", label: "Photos", types: ["Image", "Gif", "Sticker"], layout: "grid" },
  { key: "videos", label: "Videos", types: ["Video"], layout: "grid" },
  // Audio rows hold name + sender/date/duration + the inline <audio> player.
  { key: "audio", label: "Audio", types: ["Audio", "Voice"], layout: "list", rowH: 80 },
  { key: "files", label: "Files", types: ["File"], layout: "list", search: "Search files", empty: "No files found" },
];

export const MEDIA_ROW_H = 56;
const GOTO_SVG = svg(P.gotoMessage, "", 'width="20" height="20"');
const ROW_PLAY_SVG = svg(P.playFilled, "", 'width="20" height="20"');
export function gotoButtonHtml(name) {
  return `<button type="button" class="icon-btn media-goto" data-media-goto aria-label="Show ${name} in chat" title="Show in chat">${GOTO_SVG}</button>`;
}
const PLAY_SVG = `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="11" fill="rgba(0,0,0,.5)"/><path d="M9.5 7.5v9l7-4.5z" fill="#fff"/></svg>`;
// Square grid tiles: width of one column of the scroll box (minus scrollbar).
export function gridTileSize(boxWidth, cols = MEDIA_GRID_COLS) {
  const w = Number(boxWidth) > 0 ? Number(boxWidth) : 320;
  return Math.max(48, Math.floor(w / cols));
}
// Fixed virtual-list row height per list section (CSS .media-row-<key> matches).
export function mediaRowHeight(section) { return section?.rowH || MEDIA_ROW_H; }
export const MEDIA_GRID_COLS = 4;
export const MEDIA_BATCH = 50;
export const MEDIA_CACHE_MAX = 400; // mapped messages kept per sheet (LRU)

// Newest first. Missing API (PWA build without the gallery call) → null, so
// the caller hides the sections instead of showing wrong zeros.
export async function queryChatMedia(core, chatId, section) {
  if (!core?.getChatMedia) return null;
  const ids = await core.getChatMedia(chatId, section.types);
  return Array.isArray(ids) ? ids.slice().reverse() : [];
}

// Name used for display/search. Apps prefer the manifest name when known.
export function mediaItemName(m, info = null) {
  if (info?.name) return info.name;
  const f = m?.fileName || "";
  if (m?.viewtype === "webxdc") return f.replace(/\.xdc$/i, "") || "Webxdc app";
  if (m?.viewtype === "voice") return "Voice message";
  return f || (m?.viewtype === "audio" ? "Audio" : "File");
}

export function filterMedia(items, query, nameOf = (m) => mediaItemName(m)) {
  const q = foldText(query).trim();
  if (!q) return items.slice();
  return items.filter((m) => foldText(nameOf(m)).includes(q));
}

export function senderName(m) {
  return m?.from === 1 ? "You" : (m?.fromContact?.name || "");
}

// Inner HTML of one list row (apps / audio / files).
export function mediaRowHtml(section, m, { info = null, iconUrl = "" } = {}) {
  const name = escapeHtml(mediaItemName(m, info));
  const when = m.ts ? escapeHtml(formatDateTime(m.ts)) : "";
  const who = escapeHtml(senderName(m));
  const meta = (parts) => parts.filter(Boolean).join(" · ");
  if (section.key === "apps") {
    const letter = escapeHtml((mediaItemName(m, info)[0] || "?").toUpperCase());
    const icon = iconUrl ? `<img class="media-app-icon" src="${escapeAttr(iconUrl)}" alt="" loading="lazy" decoding="async">` : `<span class="media-app-icon media-app-letter" aria-hidden="true">${letter}</span>`;
    return `${icon}<span class="member-text"><span class="member-name">${name}</span><span class="member-sub">${meta([who, when])}</span></span>`
      + `<span class="member-actions">${gotoButtonHtml(name)}</span>`;
  }
  if (section.key === "audio") {
    const dur = m.duration ? formatDuration(m.duration) : "";
    return `<button type="button" class="icon-btn media-play" data-media-play aria-label="Play ${name}">${ROW_PLAY_SVG}</button>`
      + `<span class="member-text"><span class="member-name">${name}</span><span class="member-sub">${meta([who, when, dur])}</span></span>`
      + `<span class="member-actions">${gotoButtonHtml(name)}</span>`;
  }
  const size = m.fileSize ? formatBytes(m.fileSize) : "";
  const pending = m.downloadState && m.downloadState !== "Done" ? "not downloaded" : "";
  return `<span class="member-text"><span class="member-name">${name}</span><span class="member-sub">${meta([size || pending, when, who])}</span></span>`
    + `<span class="member-actions"><button type="button" class="btn-text" data-media-save aria-label="Save ${name}">Save</button>${gotoButtonHtml(name)}</span>`;
}

// Inner HTML of one grid tile (photos / videos).
export function mediaTileHtml(section, m, { fileUrl = (p) => p } = {}) {
  const label = escapeAttr(`${section.key === "videos" ? "Video" : "Photo"}${m.ts ? ", " + formatDateTime(m.ts) : ""}${senderName(m) ? ", " + senderName(m) : ""}`);
  const ready = m.filePath && (!m.downloadState || m.downloadState === "Done");
  if (section.key === "videos") {
    const dur = m.duration ? `<span class="media-dur">${escapeHtml(formatDuration(m.duration))}</span>` : "";
    // Cheap real poster: only tiles in the window exist, and preload=metadata
    // with #t=0.1 decodes one frame. The placeholder background shows until
    // (or if) it paints. SVG play glyph: "▶" renders as a colour emoji on Android.
    const poster = ready ? `<video class="media-poster" src="${escapeAttr(fileUrl(m.filePath))}#t=0.1" preload="metadata" muted playsinline disablepictureinpicture tabindex="-1" aria-hidden="true"></video>` : "";
    return `<span class="media-tile-inner media-video" role="img" aria-label="${label}">${poster}<span class="media-play-glyph" aria-hidden="true">${PLAY_SVG}</span>${dur}</span>`;
  }
  if (!ready) return `<span class="media-tile-inner media-pending" role="img" aria-label="${label}, not downloaded"></span>`;
  return `<img class="media-tile-inner" src="${escapeAttr(fileUrl(m.filePath, { thumb: true }))}" alt="${label}" loading="lazy" decoding="async">`;
}

// Fetch mapped messages for ids, in batches, through a shared LRU.
export async function loadMessages(core, ids, cache, onLoaded = null) {
  const missing = ids.filter((id) => !cache.has(id));
  for (let i = 0; i < missing.length; i += MEDIA_BATCH) {
    const chunk = missing.slice(i, i + MEDIA_BATCH);
    const got = await core.getMessagesByIds(chunk);
    for (const m of got || []) {
      if (m && m.id != null) { cache.set(m.id, m); onLoaded?.(m); }
    }
  }
  return ids.map((id) => cache.get(id)).filter(Boolean);
}

export function mediaSectionsHtml() {
  return MEDIA_SECTIONS.map((s) => `<details class="info-details media-details" data-media="${s.key}" hidden>
      <summary class="info-row"><span class="k">${t(s.label)}</span><span class="v" data-media-count aria-label="${t(s.label)} count">…</span></summary>
      <div class="media-body" data-media-body></div>
    </details>`).join("");
}

// Wire every section inside `root`. opts: { core, chatId, fileUrl, isCurrent,
// onOpen(sectionKey, msg), onSave(msg), appInfo(msgId) -> {name, icon}?,
// appIconUrl(msgId, icon), viewportH, doc }.
// Returns { sections: Map(key -> controller), ready } for tests.
export function mountChatMedia(root, opts) {
  const { core, chatId, isCurrent = () => true } = opts;
  const cache = new LruCache({ maxItems: MEDIA_CACHE_MAX, maxBytes: Infinity, sizeOf: () => 0 });
  const sections = new Map();
  const ready = Promise.all(MEDIA_SECTIONS.map(async (section) => {
    const el = root.querySelector(`[data-media="${section.key}"]`);
    if (!el) return;
    if (!chatId) return; // no chat scope → stay hidden (the core reads a null chatId as "all chats", #159)
    let ids;
    try { ids = await queryChatMedia(core, chatId, section); } catch { ids = null; }
    if (!isCurrent() || ids == null) return; // unsupported → stays hidden
    el.hidden = false;
    const count = el.querySelector("[data-media-count]");
    count.textContent = ids.length.toLocaleString();
    const ctl = { section, ids, el, mounted: null, loads: 0 };
    sections.set(section.key, ctl);
    if (!ids.length) { el.querySelector("summary")?.setAttribute("aria-disabled", "true"); }
    ctl.open = async () => {
      if (!ids.length) return null;
      if (ctl.mounted) { await ctl.mounted.ready; return ctl.mounted; }
      ctl.loads++;
      const body = el.querySelector("[data-media-body]");
      ctl.mounted = mountSection(body, section, ids, cache, opts);
      await ctl.mounted.ready;
      return ctl.mounted;
    };
    el.addEventListener("toggle", () => { if (el.open) ctl.open(); });
    if (el.open) ctl.open();
  }));
  return { sections, ready, cache };
}

function mountSection(host, section, ids, cache, opts) {
  const { core, viewportH = 280, doc = document, isCurrent = () => true } = opts;
  const fileUrl = opts.fileUrl || ((p) => p);
  host.replaceChildren();
  const grid = section.layout === "grid";
  const infos = new Map();
  const names = new Map(); // id -> search name (strings only; survives LRU eviction)
  const nameOf = (m) => names.get(m.id) ?? mediaItemName(cache.get(m.id) || m, infos.get(m.id));

  let input = null, clear = null;
  if (section.search) {
    const row = buildSearchRow(doc, { placeholder: t(section.search), clearLabel: section.key === "apps" ? t("Clear apps search") : t("Clear files search") });
    ({ input, clear } = row);
    host.append(row.search);
  }
  const { scroller, spacer, empty } = buildVirtualScroller(doc, {
    className: `member-scroll media-scroll${grid ? " media-grid" : ""}`,
    viewportH,
    label: t(section.label),
    emptyText: section.empty ? t(section.empty) : section.key === "photos" ? t("No photos") : section.key === "videos" ? t("No videos") : section.key === "audio" ? t("No audio") : t("No files found"),
  });
  host.append(scroller, empty);

  // Search sections need every name up front (apps/files are small and
  // metadata-only); grids and audio load just the visible window.
  const state = { all: ids.map((id) => ({ id })), shown: null, rendered: new Map(), loaded: !section.search };
  state.shown = state.all;

  const rowH = () => grid ? gridTileSize(scroller.clientWidth) : mediaRowHeight(section);
  let laidOutH = 0;
  const unitCount = () => grid ? Math.ceil(state.shown.length / MEDIA_GRID_COLS) : state.shown.length;

  const release = (node) => {
    for (const media of [...(node.querySelectorAll?.("img") || []), ...(node.querySelectorAll?.("video") || [])]) {
      const src = media.getAttribute?.("src") || "";
      if (src.startsWith("blob:")) { try { URL.revokeObjectURL(src); } catch {} }
      media.removeAttribute?.("src");
      if (media.tagName === "VIDEO") { try { media.load?.(); } catch {} } // drop the decoder
    }
    node.remove();
  };

  const makeNode = (m, i) => {
    const node = doc.createElement("div");
    const h = rowH();
    node.className = grid ? "media-tile" : `member-row media-row media-row-${section.key}`;
    node.setAttribute("role", "listitem");
    node.dataset.index = String(i);
    node.dataset.msgId = String(m.id);
    node.style.position = "absolute";
    if (grid) {
      node.style.top = `${Math.floor(i / MEDIA_GRID_COLS) * h}px`;
      node.style.left = `${(i % MEDIA_GRID_COLS) * h}px`;
      node.style.width = `${h}px`;
      node.style.height = `${h}px`;
    } else {
      node.tabIndex = 0;
      node.style.top = `${i * h}px`;
      node.style.left = "0";
      node.style.right = "0";
      node.style.height = `${h}px`;
    }
    const full = cache.get(m.id);
    if (!full) { node.classList.add("media-loading"); node.dataset.loading = "1"; node.setAttribute("aria-busy", "true"); return node; }
    // A tile is a div holding two real buttons (open, show in chat): no
    // nested interactive content, both reachable by keyboard.
    if (grid) node.innerHTML = `<button type="button" class="media-open" data-media-open>${mediaTileHtml(section, full, { fileUrl })}</button>`
      + gotoButtonHtml(section.key === "videos" ? "video" : "photo");
    else {
      const info = infos.get(m.id);
      node.innerHTML = mediaRowHtml(section, full, { info, iconUrl: info?.icon && opts.appIconUrl ? opts.appIconUrl(m.id, info.icon) : "" });
    }
    return node;
  };

  let pending = null;
  const render = () => {
    const n = state.shown.length;
    const h = rowH();
    // Width changed (first layout after <details> opened, rotation, resize):
    // tiles are positioned in px, so re-lay them all out square.
    if (grid && laidOutH && h !== laidOutH) {
      for (const node of state.rendered.values()) release(node);
      state.rendered.clear();
    }
    laidOutH = h;
    spacer.style.height = `${unitCount() * h}px`;
    empty.hidden = n > 0;
    const vh = scroller.clientHeight || viewportH;
    const win = virtualWindow({ scrollTop: scroller.scrollTop, viewportH: vh, rowH: h, count: unitCount() });
    const start = grid ? win.start * MEDIA_GRID_COLS : win.start;
    const end = grid ? Math.min(n, win.end * MEDIA_GRID_COLS) : win.end;
    for (const [i, node] of state.rendered) {
      const stale = node.dataset.loading === "1" && cache.has(state.shown[i]?.id);
      if (i < start || i >= end || stale) { release(node); state.rendered.delete(i); }
    }
    const need = [];
    for (let i = start; i < end; i++) {
      if (state.rendered.has(i)) continue;
      const m = state.shown[i];
      if (!cache.has(m.id)) need.push(m.id);
      const node = makeNode(m, i);
      spacer.appendChild(node);
      state.rendered.set(i, node);
    }
    if (need.length && !pending) {
      pending = loadMessages(core, need, cache).catch(() => []).then(() => {
        pending = null;
        if (isCurrent() && host.isConnected !== false) render();
      });
    }
    return pending;
  };

  const setShown = (list) => {
    state.shown = list;
    for (const node of state.rendered.values()) release(node);
    state.rendered.clear();
    scroller.scrollTop = 0;
    render();
  };
  const applyFilter = () => {
    if (clear) clear.hidden = !input.value;
    setShown(filterMedia(state.all, input?.value || "", nameOf));
  };

  const itemAt = (node) => cache.get(state.shown[Number(node.dataset.index)]?.id);
  scroller.addEventListener("scroll", () => render());
  if (grid && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => { if (host.isConnected !== false) render(); }).observe(scroller);
  }
  scroller.addEventListener("click", (e) => {
    const node = e.target?.closest?.(".media-tile, .media-row");
    if (!node) return;
    const m = itemAt(node);
    if (!m) return;
    if (e.target?.closest?.("[data-media-goto]")) { opts.onShowInChat?.(m); return; }
    if (e.target?.closest?.("[data-media-save]")) { opts.onSave?.(m); return; }
    if (e.target?.closest?.(".vp")) return; // the inline player's own controls
    if (e.target?.closest?.("[data-media-play]") || section.key === "audio") { playInline(node, m); return; }
    opts.onOpen?.(section.key, m);
  });
  scroller.addEventListener("keydown", (e) => {
    const node = e.target?.closest?.(".media-row");
    if (!node || e.target !== node || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault?.();
    const m = itemAt(node);
    if (!m) return;
    if (section.key === "audio") playInline(node, m);
    else opts.onOpen?.(section.key, m);
  });

  // Audio: one shared player per section (the chat's own bar, see
  // audio-player.js), moved into the tapped row.
  let player = null;
  const playInline = (node, m) => {
    if (!m.filePath) { opts.onOpen?.(section.key, m); return; }
    player?.box.remove();
    const box = doc.createElement("div");
    box.className = "media-audio";
    box.innerHTML = audioPlayerHtml({ label: m.viewtype === "voice" ? "Voice message" : "Audio", duration: m.duration });
    const audio = doc.createElement("audio");
    audio.preload = "metadata";
    audio.hidden = true;
    box.appendChild(audio);
    const url = fileUrl(m.filePath);
    mountAudioPlayer(box, audio, { duration: m.duration, decodeDuration: () => decodeAudioDuration(url) });
    audio.src = url;
    player = { box, audio };
    node.querySelector(".member-text")?.appendChild(box);
    audio.play?.()?.catch?.(() => {});
  };

  const ready = (async () => {
    if (section.search) {
      for (const id of ids) { const c = cache.peek(id); if (c) names.set(id, mediaItemName(c)); }
      await loadMessages(core, ids, cache, (m) => names.set(m.id, mediaItemName(m)));
      if (section.key === "apps" && opts.appInfo) {
        for (const id of ids) {
          try {
            const info = await opts.appInfo(id);
            if (info) { infos.set(id, info); if (info.name) names.set(id, info.name); }
          } catch {}
        }
      }
      state.loaded = true;
      if (!isCurrent()) return;
      if (input) {
        input.addEventListener("input", applyFilter);
        clear.addEventListener("click", () => { input.value = ""; applyFilter(); input.focus?.(); });
      }
      applyFilter();
    } else {
      await render();
    }
  })();

  return { state, input, scroller, render, ready, infos };
}
