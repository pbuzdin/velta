// lang-cards.js — "Velta speaks your language" cards in Device Messages.
// When the OS / browser language (navigator.languages; the Android WebView
// reports the system locale there too) is one Velta ships and the UI is in
// another, app.js adds a device message (label velta-lang-<code>, so core
// adds it once per account) whose text ends in velta://lang/<code>. Only
// messages from the device contact in the device chat render the card; the
// same link anywhere else stays plain text, and the OS deeplink handler
// ignores it. Tap or any language switch sets a flag: no new cards after.
import { LANGS, normalizeLang, currentLang } from "./i18n.js";

export const LANG_CARD_DONE_KEY = "velta-lang-card-done";
export const LANG_CARD_LINK_RE = /(?:^|\s)velta:\/\/lang\/([a-z]{2})(?=\s|$)/i;

// Written in the target language: the reader may not read the current UI one.
export const LANG_CARDS = {
  ru: { text: "Velta поддерживает русский язык 🇷🇺", action: "Переключить на русский", current: "Русский уже включён" },
  fr: { text: "Velta est disponible en français 🇫🇷", action: "Passer au français", current: "Le français est déjà activé" },
};

const shipped = (code) => code !== "en" && LANGS.some(([c]) => c === code) && !!LANG_CARDS[code];
const store = () => { try { return globalThis.localStorage || null; } catch { return null; } };

export const langCardLabel = (code) => `velta-lang-${code}`;
export const langCardText = (code) => `${LANG_CARDS[code].text}\n\nvelta://lang/${code}`;
export const langCardDone = () => store()?.getItem(LANG_CARD_DONE_KEY) === "1";
export function markLangCardDone() { try { store()?.setItem(LANG_CARD_DONE_KEY, "1"); } catch {} }

// Primary OS language, if Velta ships it (en excluded: it is the default).
export function osLang(languages = globalThis.navigator?.languages, fallback = globalThis.navigator?.language) {
  const first = (Array.isArray(languages) && languages.length ? languages[0] : fallback) || "";
  const code = normalizeLang(first);
  return shipped(code) ? code : null;
}

// Which card to add now, or null.
export function pendingLangCard({ languages, ui = currentLang(), done = langCardDone() } = {}) {
  if (done) return null;
  const code = osLang(languages);
  return code && code !== ui ? code : null;
}

export async function maybeAddLangCard(core, opts) {
  const code = pendingLangCard(opts);
  if (!code || typeof core?.addDeviceMessage !== "function") return null;
  try { return await core.addDeviceMessage(langCardLabel(code), langCardText(code)); }
  catch (e) { console.warn("lang card failed", e); return null; }
}

// Language code of a card message, or null. trusted = device chat AND device sender.
export function langCardCode(text, { trusted }) {
  if (!trusted) return null;
  const m = LANG_CARD_LINK_RE.exec(String(text || ""));
  const code = m ? m[1].toLowerCase() : null;
  return code && shipped(code) ? code : null;
}

export const stripLangLink = (text) => String(text || "").replace(/\s*velta:\/\/lang\/[a-z]{2}\s*$/i, "");

export function langCardHtml(code, { ui = currentLang(), esc }) {
  const c = LANG_CARDS[code];
  if (!c) return "";
  const on = ui === code;
  return `<div class="ivc lang-card" lang="${code}"><div class="ivc-acts">${on
    ? `<button type="button" class="ivc-btn" disabled aria-disabled="true" aria-current="true">${esc(c.current)}</button>`
    : `<button type="button" class="ivc-btn ivc-primary" data-lang-card="${code}">${esc(c.action)}</button>`}</div></div>`;
}
