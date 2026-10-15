// hashtags.js — find #hashtags in plain message text (#134). Pure string
// logic, no DOM; markdown.js renders the matches as focusable buttons and
// chat-view turns a tap into a search for the tag in the current chat.
//
// Rules (Telegram/Delta Chat-like):
//  * A tag is "#" followed by 1–64 Unicode letters, marks, digits or "_"
//    (Latin, Cyrillic, any script): "#velta", "#привет", "#tag_2026".
//  * It must contain at least one letter: pure numbers ("#123", "#1_000")
//    are issue/item numbers, not tags, and stay plain text.
//  * The "#" must start a word: not glued to a preceding letter/digit/_ or
//    one of & # / : . @ - (so "C#", "a#b", HTML entities "&#123;", "##x",
//    "path/#x" stay literal). URLs and their #fragments never reach this
//    scanner: markdown.js links them first and only scans the text between.
//  * The tag ends at the first non-word character, so trailing punctuation
//    ("#tag," "#tag." "(#tag)") is excluded. A tag longer than 64 chars is
//    not a tag at all (no silent truncation).
// There is no code span/block syntax in Velta's markdown, so nothing is
// excluded on that account (see markdown.js header).
const TAG = /#([\p{L}\p{M}\p{N}_]+)/gu;
const BAD_BEFORE = /[\p{L}\p{M}\p{N}_&#/:.@-]/u;
export const MAX_TAG_LEN = 64;

// Non-overlapping [{ start, end, text: "#tag", tag: "tag" }] in order.
export function findHashtags(seg) {
  const s = String(seg ?? "");
  const out = [];
  TAG.lastIndex = 0;
  for (let m; (m = TAG.exec(s)); ) {
    const i = m.index;
    const tag = m[1];
    if (i > 0 && BAD_BEFORE.test(s[i - 1])) continue;
    if (!/\p{L}/u.test(tag) || /^\p{M}/u.test(tag)) continue;
    if ([...tag].length > MAX_TAG_LEN) continue;
    out.push({ start: i, end: i + m[0].length, text: m[0], tag });
  }
  return out;
}
