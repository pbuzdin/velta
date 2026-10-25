// Per-message language tag for CSS hyphenation (hyphens: auto picks its
// dictionary from `lang`). Velta only needs English vs Russian: count
// Cyrillic vs Latin letters in the (raw) message text, cheaply — at most the
// first 400 characters — and fall back to the UI language when the text has
// no letters of either script (emoji, numbers, links-only messages stay on
// the fallback). Links, e-mail addresses and bare domains are stripped
// first: their Latin letters say nothing about the language around them.
const CYR = /[\u0400-\u04FF]/;
const LAT = /[A-Za-z\u00C0-\u024F]/;
const MACHINE = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\S+@\S+\.\S+|\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/\S*)?/gi;

export function uiLang(doc = globalThis.document, nav = globalThis.navigator) {
  const raw = (doc?.documentElement?.lang || nav?.language || "en").toLowerCase();
  return raw.startsWith("ru") ? "ru" : "en";
}

export function detectTextLang(text, fallback = "en") {
  if (typeof text !== "string" || !text) return fallback;
  text = text.slice(0, 2000).replace(MACHINE, " ");
  let cyr = 0, lat = 0;
  const n = Math.min(text.length, 400);
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (CYR.test(ch)) cyr++;
    else if (LAT.test(ch)) lat++;
  }
  if (!cyr && !lat) return fallback;
  // Ties go to the fallback; a Russian sentence with an English brand name
  // ("Открой Velta и…") still reads as Russian.
  if (cyr === lat) return fallback;
  return cyr > lat ? "ru" : "en";
}
