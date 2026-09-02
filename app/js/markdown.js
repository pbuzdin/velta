// markdown.js — simple, escape-first markdown for message text:
//   **bold**   __underline__   *italic* / _italic_
//   [label](https://…) links, bare URLs (and invite cards via invites.js)
//   "- item" / "* item" bullets and "1." / "1)" numbered lists
// All text is HTML-escaped before any tag is produced; only http(s) URLs
// become links, so message content can never inject markup.
import { escapeHtml, escapeAttr } from "./components.js";
import { parseInviteLink, inviteCardHtml } from "./invites.js";

const TRAILING_PUNCT = /[.,;:!?)\]'}>]+$/;
const PLACEHOLDER_RE = /\x00(\d+)\x00/g;

export function renderMarkdown(rawText) {
  const text = String(rawText ?? "");
  if (!text) return "";
  // Block pass: consecutive "- "/"* "/"1." lines become lists; everything
  // else stays a pre-wrapped paragraph (the newline joining keeps msg-text's
  // white-space: pre-wrap line breaks).
  const blocks = [];
  let list = null; // { type: "ul" | "ol", items: string[], start: number }
  const flushList = () => {
    if (!list) return;
    const start = list.type === "ol" && list.start > 1 ? ` start="${list.start}"` : "";
    blocks.push(`<${list.type}${start}>` + list.items.map(i => `<li>${i}</li>`).join("") + `</${list.type}>`);
    list = null;
  };
  for (const line of text.split("\n")) {
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const numbered = /^\s*(\d{1,9})[.)]\s+(.+)$/.exec(line);
    if (bullet) {
      if (list?.type !== "ul") { flushList(); list = { type: "ul", items: [], start: 0 }; }
      list.items.push(inline(bullet[1]));
    } else if (numbered) {
      if (list?.type !== "ol") { flushList(); list = { type: "ol", items: [], start: +numbered[1] }; }
      list.items.push(inline(numbered[2]));
    } else {
      flushList();
      blocks.push(inline(line));
    }
  }
  flushList();
  return blocks.join("\n");
}

// Inline pass on one line/block, single combined scan: [label](url) links are
// matched before bare URLs (so the URL inside ](…) isn't grabbed as a bare
// link), bare URLs become anchors or invite cards. Matches are replaced by
// opaque placeholders BEFORE escaping/emphasis, so hrefs can't be mangled by
// the emphasis rules and emphasis can't leak into attributes.
function inline(raw) {
  const re = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]*)\)|\bhttps?:\/\/[^\s<]+/gi;
  const anchors = [];
  let work = "";
  let last = 0;
  for (let m; (m = re.exec(raw)); ) {
    const isMdLink = m[1] !== undefined;
    let token;
    let trailing = "";
    if (isMdLink) {
      token = `<a href="${escapeAttr(m[2])}" target="_blank" rel="noopener">${formatInline(escapeHtml(m[1]))}</a>`;
    } else {
      const url = m[0].replace(TRAILING_PUNCT, "");
      trailing = m[0].slice(url.length); // don't let punctuation glue onto the link
      const invite = parseInviteLink(url);
      token = invite ? inviteCardHtml(invite)
        : `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`;
    }
    anchors.push(token);
    work += raw.slice(last, m.index) + `\x00${anchors.length - 1}\x00` + escapeHtml(trailing);
    last = m.index + m[0].length;
  }
  work += raw.slice(last);
  return formatInline(escapeHtml(work)).replace(PLACEHOLDER_RE, (_, n) => anchors[+n]);
}

// Emphasis rules on already-escaped text. Longest marker first (** before *,
// __ before _); openers must not sit inside a word ("2*3*4" stays literal)
// and markers may not span lines.
function formatInline(escaped) {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w_])__([^_\n]+)__(?![\w_])/g, "$1<u>$2</u>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, "$1<em>$2</em>");
}
