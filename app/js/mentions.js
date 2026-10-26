// mentions.js — @mentions, names + fingerprint code (docs/mentions.md).
// Pure parsing/matching plus the composer member picker. No core changes:
// the wire format is plain text, so Delta Chat shows it verbatim:
//   "@Display Name (A1B2) hey"
// where A1B2 is the first 4-hex group of the member's OpenPGP fingerprint
// (uppercase, as Delta Chat shows fingerprints). The code survives renames
// and tells duplicate names apart; plain "@Name" (typed / legacy) still
// matches by name.
//
// A member here is { id, name, code } — code "" when the fingerprint is
// unknown or only derived (no key). SELF is contact id 1.
import { t } from "./i18n.js";

const WORD = /[\p{L}\p{M}\p{N}_]/u;
// "@" must start a word: not glued to a letter/digit or an e-mail/handle
// character ("a@b.c", "x.@y", "@@y" are not mentions).
const BAD_BEFORE = /[\p{L}\p{M}\p{N}_.@+\-%&/:#]/u;
const CODE_AFTER = /^ \(([0-9A-Fa-f]{4})\)/;
// "@<name> (XXXX)": the name runs up to the code (rename-proof path).
const CODED = /^@([^\n@()]{1,64}?) \(([0-9A-Fa-f]{4})\)/u;
export const MAX_NAME = 64;

// First 4-hex group of a fingerprint, uppercase; "" if not a real one.
export function fprCode(fpr) {
  const hex = String(fpr || "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
  return hex.length >= 40 ? hex.slice(0, 4) : "";
}

// What the picker inserts (trailing space included).
export function mentionToken(member) {
  const name = String(member?.name || "").trim();
  return member?.code ? `@${name} (${member.code}) ` : `@${name} `;
}

const fold = s => String(s || "").toLocaleLowerCase();
const boundaryAt = (s, i) => i >= s.length || !WORD.test(s[i]);

// Members whose name matches seg at `at` (right after "@"), longest first.
function nameMatches(seg, at, members) {
  const lower = fold(seg);
  let best = 0, hits = [];
  for (const m of members) {
    const n = fold(String(m.name || "").trim());
    if (!n || n.length > MAX_NAME || n.length < best) continue;
    if (lower.startsWith(n, at) && boundaryAt(seg, at + n.length)) {
      if (n.length > best) { best = n.length; hits = [m]; } else hits.push(m);
    }
  }
  return { len: best, hits };
}

// Resolve one "@…" at index i. Returns { start, end, member, code } or null.
function resolveAt(seg, i, members) {
  const rest = seg.slice(i);
  const coded = CODED.exec(rest);
  if (coded) {
    const code = coded[2].toUpperCase();
    const typed = fold(coded[1].trim());
    const end = i + coded[0].length;
    if (boundaryAt(seg, end) || /[\s.,!?;:)\]]/.test(seg[end])) {
      const byCode = members.filter(m => m.code === code);
      let member = byCode.length === 1 ? byCode[0] : null;
      // Prefix collision: name + code, then name alone.
      if (!member && byCode.length > 1) member = byCode.find(m => fold(m.name.trim()) === typed) || null;
      // Code matches nobody: a same-named member with no known code (no key
      // yet) is still meant; one whose code differs is someone else.
      if (!member) member = members.find(m => fold(String(m.name || "").trim()) === typed && (!m.code || byCode.length > 1)) || null;
      if (member) return { start: i, end, member, code };
    }
  }
  const { len, hits } = nameMatches(seg, i + 1, members);
  if (!len) return null;
  let end = i + 1 + len;
  const c = CODE_AFTER.exec(seg.slice(end));
  // "@Name (XXXX)" whose code belongs to nobody fell through above; keep the
  // code out of the chip unless it is the member's own.
  let member = hits[0];
  if (c) {
    const code = c[1].toUpperCase();
    const own = hits.find(m => m.code === code);
    if (own) { member = own; end += c[0].length; return { start: i, end, member, code }; }
    if (hits.every(m => m.code)) return null; // names a different person
  }
  return { start: i, end, member, code: "" };
}

// Non-overlapping mentions in plain text, in order:
// [{ start, end, text, member, code, me }].
export function findMentions(seg, members, { selfId = 1 } = {}) {
  const s = String(seg ?? "");
  const list = (members || []).filter(m => m && String(m.name || "").trim());
  const out = [];
  if (!list.length || !s.includes("@")) return out;
  for (let i = s.indexOf("@"); i !== -1; i = s.indexOf("@", i + 1)) {
    if (i > 0 && BAD_BEFORE.test(s[i - 1])) continue;
    const r = resolveAt(s, i, list);
    if (!r) continue;
    out.push({ ...r, text: s.slice(r.start, r.end), me: r.member.id === selfId });
    i = r.end - 1;
  }
  return out;
}

// Does text mention me? self = { name, code }. Used by the notify gate,
// which knows only its own identity (no member list needed).
export function mentionsMe(text, self) {
  if (!self?.name && !self?.code) return false;
  const me = { id: 1, name: self.name || "", code: self.code || "" };
  // Code-only match (rename-proof): "@Anything (MYCODE)".
  if (me.code) {
    const re = /(^|[^\p{L}\p{M}\p{N}_.@+\-%&/:#])@[^\n@()]{1,64}? \(([0-9A-Fa-f]{4})\)/gu;
    for (const m of String(text || "").matchAll(re)) if (m[2].toUpperCase() === me.code) return true;
  }
  if (!me.name) return false;
  return findMentions(text, [me]).some(x => x.me);
}

// Composer: the "@query" being typed at the caret, or null.
export function mentionQuery(value, caret = value.length) {
  const v = String(value ?? "").slice(0, caret);
  const at = v.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s|[(\[{"'«]/u.test(v[at - 1])) return null;
  const q = v.slice(at + 1);
  if (q.length > 40 || /\n|^\s|\s{2}|@|\(/.test(q)) return null;
  return { start: at, query: q };
}

// Picker list: others first-word/prefix matches before substring ones.
export function filterMembers(members, query, { selfId = 1, limit = 8 } = {}) {
  const q = fold(query).normalize("NFD").replace(/\p{M}/gu, "");
  const norm = s => fold(s).normalize("NFD").replace(/\p{M}/gu, "");
  const scored = [];
  for (const m of members || []) {
    if (!m || m.id === selfId || !String(m.name || "").trim()) continue;
    const n = norm(m.name);
    const rank = !q ? 1 : n.startsWith(q) ? 0 : n.split(/\s+/).some(w => w.startsWith(q)) ? 1 : n.includes(q) ? 2 : -1;
    if (rank >= 0) scored.push([rank, m]);
  }
  scored.sort((a, b) => a[0] - b[0] || String(a[1].name).localeCompare(String(b[1].name)));
  return scored.slice(0, limit).map(x => x[1]);
}

// Composer picker. getMembers() → member list ([] / null = not a group).
// avatarHtml(member) renders the avatar. Returns { update, hide,
// handleKey, isOpen } like recent-commands.js.
export function attachMentionPicker(input, anchor, getMembers, avatarHtml = () => "") {
  const doc = input.ownerDocument;
  let pop = null, items = [], active = 0, q = null;
  const optId = i => `mention-opt-${i}`;
  function hide() {
    if (!pop) return;
    pop.remove(); pop = null; items = []; active = 0; q = null;
    input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-expanded", "false");
  }
  function paint() {
    if (!pop) return;
    [...pop.children].forEach((li, i) => {
      li.setAttribute("aria-selected", i === active ? "true" : "false");
      li.classList.toggle("active", i === active);
    });
    input.setAttribute("aria-activedescendant", optId(active));
    pop.children[active]?.scrollIntoView?.({ block: "nearest" });
  }
  function choose(i) {
    const m = items[i];
    if (!m || !q) return;
    const caret = input.selectionStart ?? input.value.length;
    const tok = mentionToken(m);
    input.value = input.value.slice(0, q.start) + tok + input.value.slice(caret);
    const pos = q.start + tok.length;
    try { input.selectionStart = input.selectionEnd = pos; } catch {}
    hide();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    hide();
    input.focus();
  }
  function update() {
    const members = getMembers() || [];
    q = members.length ? mentionQuery(input.value, input.selectionStart ?? input.value.length) : null;
    if (!q) return hide();
    items = filterMembers(members, q.query);
    if (!items.length) return hide();
    if (!pop) {
      pop = doc.createElement("ul");
      pop.id = "mention-picker";
      pop.className = "recent-commands-pop mention-pop";
      pop.setAttribute("role", "listbox");
      pop.setAttribute("aria-label", t("Mention a member"));
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
    items.forEach((m, i) => {
      const li = doc.createElement("li");
      li.id = optId(i);
      li.setAttribute("role", "option");
      li.dataset.idx = String(i);
      li.innerHTML = avatarHtml(m);
      const name = doc.createElement("span");
      name.className = "mention-opt-name";
      name.textContent = m.name;
      li.appendChild(name);
      if (m.code) {
        const code = doc.createElement("span");
        code.className = "mention-code";
        code.textContent = m.code;
        li.appendChild(code);
      }
      pop.appendChild(li);
    });
    if (active >= items.length) active = 0;
    paint();
  }
  function handleKey(e) {
    if (!pop || e.isComposing) return false;
    const n = items.length;
    if (e.key === "ArrowDown") { active = (active + 1) % n; paint(); }
    else if (e.key === "ArrowUp") { active = active <= 0 ? n - 1 : active - 1; paint(); }
    else if (e.key === "Escape") hide();
    else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) choose(active);
    else return false;
    e.preventDefault();
    e.stopPropagation?.();
    return true;
  }
  input.addEventListener("input", () => { active = 0; update(); });
  input.addEventListener("click", update);
  input.addEventListener("blur", hide);
  return { update, hide, handleKey, isOpen: () => !!pop };
}
