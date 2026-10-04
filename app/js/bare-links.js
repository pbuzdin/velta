// bare-links.js — find web addresses typed WITHOUT a scheme ("t.me/x/1",
// "github.com/user/repo", "www.example.com", "example.com:8080/a?b=c#d") so
// markdown.js can render them like https:// links (#85). Pure string logic, no
// DOM. The result's `url` is always "https://" + the typed text, validated by
// the URL parser; nothing here can ever yield another scheme.
//
// Detection is deliberately conservative, because a bare "word.word" is
// ambiguous: file names (main.js, notes.md, setup.py), code (user.id,
// logger.info), versions (v1.2.3), abbreviations (e.g.) and sentences typed
// without a space ("done.Next") all look like hosts. A candidate is linked
// only when ALL of these hold:
//  * It starts at a word boundary: not glued to a preceding letter/digit/_ or
//    one of @ . / : % + ~ # = & ? \ $ - (so e-mail addresses, parts of other
//    URLs, "src/main.rs" and "a=foo.com" are skipped).
//  * It ends cleanly: not followed by a letter/digit/_/@/- ("foo.com@x" is an
//    e-mail local part, "foo.com_x" is an identifier).
//  * The TLD is lowercase letters (or xn--punycode, or "рф") and is on the
//    list below. Uppercase/capitalized TLDs ("sentence.Next", "ASP.NET") never
//    match. Labels may be any case and may be Unicode (IDN): "пример.рф",
//    "GitHub.com". Numeric TLDs (v1.2.3, 3.14, 192.168.0.1) never match.
//  * The TLD tier is satisfied (see below).
// Query strings, fragments, ports and balanced parentheses in the path are
// kept; trailing punctuation (. , ; : ! ? ' " * > ) ] }) is not.

// Tier 1: unambiguous enough to link a bare host with nothing after it
// ("example.com", "mail.ru").
const TIER1 = new Set((
  "com org net edu gov mil int io " +
  "ru su ua by kz uz ge de uk fr nl es pt se fi dk cz hu ro bg gr tr cn jp kr au nz ca br eu ch lv lt ee xn--p1ai рф"
).split(" "));

// Tier 2: real, popular suffixes that are also common identifier/word endings
// ("log.info", "this.app", "state.store", "self.me"): linked only with a port
// or a /, ? or # after the host ("t.me/durov", "x.ai/chat", "foo.dev:3000").
const TIER2 = new Set((
  "info biz co me tv fm gg ly ai xyz dev app online site tech store shop blog cloud wiki space pro mobi"
).split(" "));

// Tier 3: every other country-code TLD. Many collide with file extensions or
// English words (py md sh rs pl cc so ml ps id in is it to at be no ...), so
// they link only when a "/" path follows ("vk.cc/abc", "onet.pl/news"), never
// as "main.rs", "main.rs:42" or "notes.md".
const TIER3 = new Set((
  "ac ad ae af ag al am ao aq ar as at aw ax az ba bb bd be bf bh bi bj bm bn bo bs bt bw bz cc cd cf cg ci ck cl cm " +
  "cr cu cv cw cx cy dj dm do dz ec eg er et fj fk fo ga gd gf gh gi gl gm gn gp gq gs gt gu gw gy hk hm hn hr ht id " +
  "ie il im in iq ir is it je jm jo ke kg kh ki km kn kp kw ky la lb lc li lk lr ls lu ma mc md mg mh mk ml mm mn mo " +
  "mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni no np nr nu om pa pe pf pg ph pk pl pm pn pr ps pw py qa re rs " +
  "rw sa sb sc sd sg sh si sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tt tw tz ug us uy va " +
  "vc ve vg vi vn vu wf ws ye yt za zm zw"
).split(" "));

// Candidates start only at the beginning of a word run (RUN), then one sticky
// HOST match extends them over dot-separated labels: every character is looked
// at a bounded number of times, so long runs of letters/dots/hyphens stay linear.
const RUN = /[\p{L}\p{N}\p{M}_-]+/gu;
const HOST = /[\p{L}\p{N}][\p{L}\p{N}-]*(?:\.[\p{L}\p{N}][\p{L}\p{N}-]*)+/uy;
const BAD_BEFORE = /[\p{L}\p{N}\p{M}_@./:%+~#=&?\\$-]/u;
const BAD_AFTER = /[\p{L}\p{N}\p{M}_@-]/u;
const CLOSERS = { ")": "(", "]": "[", "}": "{" };
const TRAIL_PUNCT = ".,;:!?'\"*>»”’…";

// Drop trailing sentence punctuation from a URL-ish string. A closing bracket
// is dropped only when it has no opener inside the URL, so
// "wiki/Foo_(bar)" keeps its ")" and "(see a.com/x)" loses it.
export function trimLinkEnd(s) {
  const bal = { "(": 0, "[": 0, "{": 0 }; // openers minus closers still inside
  for (const c of s) {
    if (c in bal) bal[c]++;
    else if (c === ")") bal["("]--;
    else if (c === "]") bal["["]--;
    else if (c === "}") bal["{"]--;
  }
  let end = s.length;
  while (end > 0) {
    const c = s[end - 1];
    if (TRAIL_PUNCT.includes(c)) { end--; continue; }
    const open = CLOSERS[c];
    if (open && bal[open] < 0) { bal[open]++; end--; continue; }
    break;
  }
  return s.slice(0, end);
}

function validHost(host) {
  if (host.length > 253) return false;
  const labels = host.split(".");
  return labels.every(l => l.length >= 1 && l.length <= 63 && !l.startsWith("-") && !l.endsWith("-"));
}

// Is `host` (+ what follows it) linkable? `rest` is the text after the host
// within the candidate: "" | ":8080" | ":8080/x" | "/x?y" | "?q" | "#f".
function accepts(host, rest) {
  if (!validHost(host)) return false;
  const labels = host.split(".");
  const tld = labels[labels.length - 1];
  if (!/^(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59}|рф)$/.test(tld)) return false;
  const hasPort = rest.startsWith(":");
  const afterPort = hasPort ? rest.replace(/^:\d{1,5}/, "") : rest;
  const hasSlash = afterPort.startsWith("/");
  const hasTail = hasSlash || /^[?#]/.test(afterPort);
  if (TIER1.has(tld)) return true;
  // "www." is an explicit web marker: any known suffix is fine on its own.
  if (labels[0].toLowerCase() === "www" && labels.length >= 3 && (TIER2.has(tld) || TIER3.has(tld))) return true;
  if (TIER2.has(tld)) return hasPort || hasTail;
  if (TIER3.has(tld)) return hasSlash && !hasPort;
  return false;
}

// Scan one plain-text segment; returns non-overlapping
// [{ start, end, text, url }] in order. `text` is the typed form, `url` is
// "https://" + text.
export function findBareLinks(seg) {
  const out = [];
  const s = String(seg ?? "");
  let skipTo = 0;
  RUN.lastIndex = 0;
  for (let r; (r = RUN.exec(s)); ) {
    const i = r.index;
    if (i < skipTo || !/^[\p{L}\p{N}]/u.test(r[0])) continue;
    HOST.lastIndex = i;
    const m = HOST.exec(s);
    if (!m) continue;
    const host = m[0];
    const hostEnd = i + host.length;
    skipTo = hostEnd;
    if (i > 0 && BAD_BEFORE.test(s[i - 1])) continue;
    if (hostEnd < s.length && BAD_AFTER.test(s[hostEnd])) continue;
    // Optional :port, then the tail (/path ?query #fragment) up to whitespace.
    let p = hostEnd;
    const port = /^:\d{1,5}(?![\p{L}\p{N}_])/u.exec(s.slice(p, p + 8));
    if (port) p += port[0].length;
    else if (s[p] === ":" && p + 1 < s.length && !/\s/.test(s[p + 1])) continue; // "foo.com:bar"
    let end = p;
    if (/[/?#]/.test(s[p] ?? "")) {
      end = p;
      while (end < s.length && !/[\s<]/.test(s[end])) end++;
    } else if (p < s.length && /[\p{L}\p{N}\p{M}_@-]/u.test(s[p])) {
      continue; // "foo.com" glued to more word characters
    }
    const cand = trimLinkEnd(s.slice(i, end));
    if (cand.length < host.length || cand.includes("\\")) continue;
    const rest = cand.slice(host.length);
    if (!accepts(host, rest)) continue;
    let url;
    try {
      const u = new URL("https://" + cand);
      if (u.protocol !== "https:" || !u.hostname) continue;
      url = "https://" + cand;
    } catch { continue; }
    out.push({ start: i, end: i + cand.length, text: cand, url });
    skipTo = i + cand.length;
  }
  return out;
}
