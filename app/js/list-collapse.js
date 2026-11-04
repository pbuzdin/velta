// #282: collapsible chat list on wide (two-pane, >= 821px) layouts. A
// floating chevron above the list bar's Menu button slides the sidebar out;
// Ctrl/⌘+B toggles too. The state is layout, not appearance, so it is kept
// in localStorage only (not in settings export).
import { t } from "./i18n.js";
import { ICON } from "./icons.js";

export const LIST_COLLAPSED_KEY = "velta-list-collapsed";
export const WIDE_QUERY = "(min-width: 821px)";

const store = () => { try { return globalThis.localStorage || null; } catch { return null; } };
export const listCollapsedPref = () => store()?.getItem(LIST_COLLAPSED_KEY) === "1";

// Unread total for the badge: chats that aren't muted (as the list badges).
export function collapsedBadgeCount(chats) {
  let n = 0;
  for (const c of chats || []) if (!c?.muted && !c?.archived && c?.unread > 0) n += c.unread;
  return n;
}

export const isToggleShortcut = (e) =>
  (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "b" || e.key === "B" || e.code === "KeyB");

export function initListCollapse({ app = document.getElementById("app"), getChats = () => [] } = {}) {
  if (!app) return null;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "btn-list-toggle";
  btn.className = "list-toggle";
  btn.setAttribute("aria-controls", "sidebar");
  btn.innerHTML = `${ICON.chevronLeft}<span class="ci-badge list-toggle-badge" hidden></span>`;
  const badge = btn.querySelector(".list-toggle-badge");
  app.appendChild(btn);
  const mq = globalThis.matchMedia?.(WIDE_QUERY);
  const wide = () => (mq ? mq.matches : true);

  const refreshBadge = () => {
    const n = app.classList.contains("list-collapsed") ? collapsedBadgeCount(getChats()) : 0;
    badge.hidden = n === 0;
    badge.textContent = n > 999 ? "999+" : String(n);
  };
  const apply = () => {
    const collapsed = wide() && listCollapsedPref();
    btn.hidden = !wide();
    app.classList.toggle("list-collapsed", collapsed);
    document.getElementById("sidebar")?.toggleAttribute("inert", collapsed);
    const label = collapsed ? t("Show chat list") : t("Hide chat list");
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.setAttribute("aria-label", label);
    btn.title = `${label} (${/Mac|iPhone|iPad/.test(globalThis.navigator?.platform || "") ? "⌘" : "Ctrl+"}B)`;
    refreshBadge();
  };
  const toggle = () => {
    if (!wide()) return;
    store()?.setItem(LIST_COLLAPSED_KEY, listCollapsedPref() ? "0" : "1");
    apply();
  };
  btn.addEventListener("click", toggle);
  document.addEventListener("keydown", (e) => {
    if (isToggleShortcut(e) && wide()) { e.preventDefault(); toggle(); }
  });
  mq?.addEventListener?.("change", apply);
  apply();
  return { toggle, apply, refreshBadge, el: btn };
}
