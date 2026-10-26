// Recent bot commands (#135). Typing "/" at the start of the composer opens a
// listbox above #main-composer with the 10 most recent distinct commands the
// user sent, most recent first, prefix-filtered as they type. Selecting one
// inserts it (never auto-sends).
//
// Storage: localStorage "velta-recent-commands" =
//   { "<accountId>": { "global": [..], "chats": { "<chatId>": [..] } } }
// Each list is most-recent-first, distinct, capped at 10. A command is the
// sent message's first line, trimmed, max 64 chars, recorded only when the
// message starts with "/". Lookup is per-chat; a chat with no history falls
// back to the account-wide (global) list. Storage failures degrade to
// "no history", never an error.
import { t } from "./i18n.js";

export const KEY = "velta-recent-commands";
export const MAX = 10;
export const MAX_LEN = 64;
const MAX_CHATS = 200;

function load() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}
function save(obj) {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(obj)); } catch { /* unavailable */ }
}

// Normalize sent text to a command, or null when it isn't one.
export function commandFromText(text) {
  const line = String(text ?? "").split(/\r?\n/, 1)[0].trim();
  if (!line.startsWith("/") || line.length < 2 || /^\/\s/.test(line)) return null;
  return line.slice(0, MAX_LEN).trimEnd();
}

const push = (list, cmd) => [cmd, ...(Array.isArray(list) ? list : []).filter(c => c !== cmd)].slice(0, MAX);

export function recordCommand(accountId, chatId, text) {
  const cmd = commandFromText(text);
  if (!cmd) return null;
  const all = load();
  const acc = all[String(accountId)] && typeof all[String(accountId)] === "object" ? all[String(accountId)] : {};
  acc.global = push(acc.global, cmd);
  const chats = acc.chats && typeof acc.chats === "object" ? acc.chats : {};
  const cid = String(chatId);
  const next = push(chats[cid], cmd);
  delete chats[cid];
  chats[cid] = next; // re-insert: insertion order = recency, used for pruning
  const ids = Object.keys(chats);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_CHATS))) delete chats[id];
  acc.chats = chats;
  all[String(accountId)] = acc;
  save(all);
  return cmd;
}

export function recentCommands(accountId, chatId, prefix = "/") {
  const acc = load()[String(accountId)] || {};
  const chatList = acc.chats?.[String(chatId)];
  const list = Array.isArray(chatList) && chatList.length ? chatList : (Array.isArray(acc.global) ? acc.global : []);
  const p = String(prefix || "").toLowerCase();
  return list.filter(c => typeof c === "string" && c.toLowerCase().startsWith(p)).slice(0, MAX);
}

// Popup controller. getCtx() → { accountId, chatId } or null.
// Returns { update, hide, handleKey, isOpen }. handleKey(e) returns true when
// it consumed the key (caller must then skip its own Enter-to-send).
export function attachRecentCommands(input, anchor, getCtx) {
  const doc = input.ownerDocument;
  let pop = null, items = [], active = -1;
  const optId = i => `recent-cmd-opt-${i}`;

  function hide() {
    pop?.remove(); pop = null; items = []; active = -1;
    input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-expanded", "false");
  }
  function paint() {
    if (!pop) return;
    [...pop.children].forEach((li, i) => {
      li.setAttribute("aria-selected", i === active ? "true" : "false");
      li.classList.toggle("active", i === active);
    });
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", optId(active));
      pop.children[active]?.scrollIntoView?.({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }
  function choose(i) {
    const cmd = items[i];
    if (cmd == null) return;
    input.value = cmd + " ";
    try { input.selectionStart = input.selectionEnd = input.value.length; } catch {}
    hide();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    hide(); // the input event re-opens on "/..." — a chosen command closes it
    input.focus();
  }
  function update() {
    const v = input.value;
    const ctx = getCtx();
    if (!ctx || !v.startsWith("/") || v.includes("\n")) return hide();
    const list = recentCommands(ctx.accountId, ctx.chatId, v);
    if (!list.length || (list.length === 1 && list[0] === v.trim())) return hide();
    items = list;
    if (!pop) {
      pop = doc.createElement("ul");
      pop.id = "recent-commands";
      pop.className = "recent-commands-pop";
      pop.setAttribute("role", "listbox");
      pop.setAttribute("aria-label", t("Recent commands"));
      // pointerdown + preventDefault: keep focus (and the Android soft
      // keyboard) on the textarea while tapping an option.
      pop.addEventListener("pointerdown", e => e.preventDefault());
      pop.addEventListener("mousedown", e => e.preventDefault());
      pop.addEventListener("click", e => {
        const li = e.target.closest?.("[role=option]");
        if (li) choose(Number(li.dataset.idx));
      });
      anchor.appendChild(pop);
      input.setAttribute("aria-controls", pop.id);
      input.setAttribute("aria-expanded", "true");
    }
    pop.textContent = "";
    items.forEach((c, i) => {
      const li = doc.createElement("li");
      li.id = optId(i);
      li.setAttribute("role", "option");
      li.dataset.idx = String(i);
      li.textContent = c;
      pop.appendChild(li);
    });
    if (active >= items.length) active = items.length - 1;
    paint();
  }
  function handleKey(e) {
    if (!pop || e.isComposing) return false;
    const n = items.length;
    if (e.key === "ArrowDown") { active = (active + 1) % n; paint(); }
    else if (e.key === "ArrowUp") { active = active <= 0 ? n - 1 : active - 1; paint(); }
    else if (e.key === "Escape") hide();
    else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && active >= 0) choose(active);
    else if (e.key === "Tab" && !e.shiftKey && n) choose(0);
    else return false;
    e.preventDefault();
    e.stopPropagation?.();
    return true;
  }
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.addEventListener("input", () => { active = -1; update(); });
  input.addEventListener("blur", hide);
  return { update, hide, handleKey, isOpen: () => !!pop };
}
