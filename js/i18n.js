// UI language (#129). English strings in the source are the keys. Packs live in
// app/locales/{fr,ru}.json: a blank or missing value keeps the English key.
// Product names (Velta, Velta Circle, Velta Beam, QR, Delta Chat, chatmail)
// stay as written. Picker names (English, Français, Русский) are not keys.

export const LANG_KEY = "velta-lang";
export const LANGS = [["en", "English"], ["fr", "Français"], ["ru", "Русский"]];

// JSON import attributes ("with { type: \"json\" }") are a hard parse error on
// WebKit < 17.2 (macOS Tauri/PWA) and kill the whole module graph, so load the
// packs by URL instead. Top-level await keeps every importer waiting until the
// packs settle, so t() stays synchronous for all consumers.
const PACKS = {};
try {
  for (const l of LANGS.slice(1).map(([code]) => code)) {
    const url = new URL(`../locales/${l}.json`, import.meta.url);
    // Node (tests) cannot fetch file: URLs — read from disk there.
    PACKS[l] = url.protocol === "file:"
      ? JSON.parse((await import("node:fs")).readFileSync(url, "utf8"))
      : await (await fetch(url)).json();
  }
} catch {} // packs unavailable = English fallback, boot still proceeds

export function normalizeLang(raw) {
  const s = String(raw ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (s === "fr" || s === "french" || s.startsWith("fr-")) return "fr";
  if (s === "ru" || s === "russian" || s.startsWith("ru-")) return "ru";
  return "en";
}

function readStored() {
  try { return normalizeLang(localStorage.getItem(LANG_KEY)); } catch { return "en"; }
}

let lang = readStored();

export function currentLang() { return lang; }

export function setLang(next) {
  lang = normalizeLang(next);
  try {
    if (lang === "en") localStorage.removeItem(LANG_KEY);
    else localStorage.setItem(LANG_KEY, lang);
  } catch {}
  applyDocumentLang();
}

export function applyDocumentLang() {
  try { document.documentElement.lang = lang; } catch {}
}

// vars replaces {name} once. Empty pack values fall back to the English key.
export function t(key, vars) {
  const s = typeof key === "string" ? key : key == null ? "" : String(key);
  const hit = lang === "en" ? "" : PACKS[lang]?.[s];
  let out = hit ? hit : s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll("{" + k + "}", String(v));
  return out;
}

// Marked English only. Unmarked text (chat names, account names) is left alone.
export function translateTree(root) {
  if (!root?.querySelectorAll) return;
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const k = el.getAttribute("data-i18n");
    if (k) el.textContent = t(k);
  }
  for (const el of root.querySelectorAll("[data-i18n-label]")) {
    const k = el.getAttribute("data-i18n-label");
    if (!k) continue;
    const v = t(k);
    el.title = v;
    el.setAttribute("aria-label", v);
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    const k = el.getAttribute("data-i18n-placeholder");
    if (k) el.setAttribute("placeholder", t(k));
  }
  for (const el of root.querySelectorAll("[data-i18n-aria]")) {
    const k = el.getAttribute("data-i18n-aria");
    if (k) el.setAttribute("aria-label", t(k));
  }
}
