// member-list.js — group/channel member list for the chat info view:
// avatar (<velta-avatar>, fingerprint colours / monochrome fallback) + name +
// address, a live search row, and a fixed-row-height virtual window so groups
// with hundreds of members only keep the visible rows (+ overscan) in the DOM.
//
// Why not the vendored VirtualScroller (chat list / history)? It measures
// variable-height items and assumes it owns a page-level scroller; here rows
// have one fixed height inside a small modal scroll box, where the window is
// two lines of arithmetic.
import { escapeHtml, escapeAttr } from "./format.js";

export const MEMBER_ROW_H = 56;
export const MEMBER_OVERSCAN = 4;

// Case-insensitive, diacritics-insensitive ("José" matches "jose").
export function foldText(s) {
  return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

// Members whose display name or address contains the query.
export function filterMembers(members, query) {
  const q = foldText(query).trim();
  if (!q) return members.slice();
  return members.filter(m => foldText(m.name).includes(q) || foldText(m.addr).includes(q));
}

// Index range [start, end) of rows to render for a scroll position.
export function virtualWindow({ scrollTop = 0, viewportH = 0, rowH = MEMBER_ROW_H, count = 0, overscan = MEMBER_OVERSCAN }) {
  if (count <= 0 || rowH <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowH);
  const visible = Math.ceil(Math.max(0, viewportH) / rowH) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start: Math.min(start, end), end };
}

// One row's inner HTML. subtitle defaults to the address; P2P groups pass
// their reachability line. No relay/transport text here (it used to be).
export function memberRowHtml(m, { subtitle = null, actionsHtml = "" } = {}) {
  const self = m.self || m.id === 1;
  const name = `${escapeHtml(m.name || "?")}${self ? ' <span class="member-you">(you)</span>' : ""}`;
  const sub = subtitle ?? (m.addr || "");
  const contact = typeof m.id === "number" && m.id > 0 ? ` contact-id="${m.id}"` : "";
  return `<velta-avatar name="${escapeAttr(m.name || "?")}" color="${escapeAttr(m.color || "")}" kind="single" size="36"${contact}${m.addr ? ` addr="${escapeAttr(m.addr)}"` : ""}${m.avatarUrl ? ` avatar="${escapeAttr(m.avatarUrl)}"` : ""}></velta-avatar>`
    + `<span class="member-text"><span class="member-name">${name}</span><span class="member-sub">${escapeHtml(sub)}</span></span>`
    + (actionsHtml ? `<span class="member-actions">${actionsHtml}</span>` : "");
}

// Mounts search + virtual list into `host`. opts:
//   rowOptions(m) -> { subtitle, actionsHtml } (optional)
//   onOpen(m)     -> row activated (tap / Enter / Space); omitted = inert rows
//   viewportH     -> scroll box height in px (default 240)
// Returns { setMembers(list), render(), state } for tests and refreshes.
export function mountMemberList(host, members, { rowOptions = () => ({}), onOpen = null, viewportH = 240, doc = document } = {}) {
  host.replaceChildren();
  const search = doc.createElement("div");
  search.className = "member-search";
  const input = doc.createElement("input");
  input.type = "search";
  input.className = "text-field";
  input.placeholder = "Search members";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Search members");
  const clear = doc.createElement("button");
  clear.type = "button";
  clear.className = "btn-text member-search-clear";
  clear.textContent = "Clear";
  clear.setAttribute("aria-label", "Clear member search");
  clear.hidden = true;
  search.append(input, clear);

  const scroller = doc.createElement("div");
  scroller.className = "member-scroll";
  scroller.style.maxHeight = `${viewportH}px`;
  scroller.style.overflow = "auto";
  scroller.setAttribute("role", "list");
  scroller.setAttribute("aria-label", "Members");
  const spacer = doc.createElement("div");
  spacer.className = "member-spacer";
  spacer.style.position = "relative";
  scroller.append(spacer);
  const empty = doc.createElement("div");
  empty.className = "member-empty";
  empty.textContent = "No members found";
  empty.hidden = true;
  host.append(search, scroller, empty);

  const state = { all: members.slice(), shown: members.slice(), rendered: new Map(), focusIndex: -1 };

  const makeRow = (m, i) => {
    const row = doc.createElement("div");
    row.className = "member-row";
    row.setAttribute("role", "listitem");
    row.tabIndex = 0;
    row.dataset.index = String(i);
    row.dataset.memberId = String(m.id);
    row.style.position = "absolute";
    row.style.top = `${i * MEMBER_ROW_H}px`;
    row.style.left = "0";
    row.style.right = "0";
    row.style.height = `${MEMBER_ROW_H}px`;
    row.innerHTML = memberRowHtml(m, rowOptions(m) || {});
    return row;
  };

  const render = () => {
    const n = state.shown.length;
    spacer.style.height = `${n * MEMBER_ROW_H}px`;
    empty.hidden = n > 0;
    const vh = scroller.clientHeight || viewportH;
    const { start, end } = virtualWindow({ scrollTop: scroller.scrollTop, viewportH: vh, count: n });
    for (const [i, row] of state.rendered) {
      if (i < start || i >= end) { row.remove(); state.rendered.delete(i); }
    }
    for (let i = start; i < end; i++) {
      if (state.rendered.has(i)) continue;
      const row = makeRow(state.shown[i], i);
      spacer.appendChild(row);
      state.rendered.set(i, row);
    }
  };

  const setShown = (list) => {
    state.shown = list;
    for (const row of state.rendered.values()) row.remove();
    state.rendered.clear();
    scroller.scrollTop = 0;
    render();
  };
  const applyFilter = () => {
    clear.hidden = !input.value;
    setShown(filterMembers(state.all, input.value));
  };

  input.addEventListener("input", applyFilter);
  clear.addEventListener("click", () => { input.value = ""; applyFilter(); input.focus?.(); });
  scroller.addEventListener("scroll", render);

  const rowOf = (e) => e.target?.closest?.(".member-row");
  const activate = (row) => {
    const m = state.shown[Number(row.dataset.index)];
    if (m && onOpen) onOpen(m);
  };
  scroller.addEventListener("click", e => {
    if (e.target?.closest?.("button")) return; // per-member actions handle themselves
    const row = rowOf(e);
    if (row) activate(row);
  });
  const focusIndex = (i) => {
    const n = state.shown.length;
    if (!n) return;
    i = Math.max(0, Math.min(n - 1, i));
    const top = i * MEMBER_ROW_H, vh = scroller.clientHeight || viewportH;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + MEMBER_ROW_H > scroller.scrollTop + vh) scroller.scrollTop = top + MEMBER_ROW_H - vh;
    render();
    state.rendered.get(i)?.focus?.();
    state.focusIndex = i;
  };
  scroller.addEventListener("keydown", e => {
    const row = rowOf(e);
    if (!row || e.target !== row) return;
    const i = Number(row.dataset.index);
    if (e.key === "Enter" || e.key === " ") { e.preventDefault?.(); activate(row); }
    else if (e.key === "ArrowDown") { e.preventDefault?.(); focusIndex(i + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault?.(); focusIndex(i - 1); }
  });

  render();
  return {
    state, input, scroller, render,
    setMembers(list) { state.all = list.slice(); applyFilter(); },
  };
}
