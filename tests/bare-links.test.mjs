import test from "node:test";
import assert from "node:assert/strict";

// #85: addresses typed without a scheme ("t.me/smysl_doc/10234") become
// https links in message text. Pure matcher (bare-links.js) + the real
// renderMarkdown, which must send them through the same anchor / invite-card
// path as https:// links and stay safe.
import { findBareLinks, trimLinkEnd } from "../app/js/bare-links.js";

// markdown.js pulls in components.js / invites.js (custom elements, storage).
globalThis.HTMLElement = class {};
globalThis.customElements = { get() {}, define() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {} };
const { renderMarkdown } = await import("../app/js/markdown.js");

const texts = s => findBareLinks(s).map(m => m.text);
const urls = s => findBareLinks(s).map(m => m.url);

test("positives: the address from the issue and other typical shapes", () => {
  const cases = {
    "t.me/smysl_doc/10234": "t.me/smysl_doc/10234",
    "github.com/pbuzdin/velta": "github.com/pbuzdin/velta",
    "www.example.com": "www.example.com",
    "www.example.com/page": "www.example.com/page",
    "example.com": "example.com",
    "example.com:8080/a?b=c#d": "example.com:8080/a?b=c#d",
    "example.com:8080": "example.com:8080",
    "sub.domain.example.org/x": "sub.domain.example.org/x",
    "mail.ru": "mail.ru",
    "vk.cc/abc123": "vk.cc/abc123", // weak ccTLD, but has a path
    "x.ai/chat": "x.ai/chat", // tier 2 with a path
    "foo.dev:3000": "foo.dev:3000", // tier 2 with a port
    "example.com?q=1": "example.com?q=1",
    "example.com#top": "example.com#top",
    "GitHub.com/Foo": "GitHub.com/Foo", // labels may be any case
    "пример.рф": "пример.рф", // IDN label + Cyrillic TLD
    "пример.com/путь": "пример.com/путь",
    "münchen.de": "münchen.de",
    "wiki.org/Foo_(bar)": "wiki.org/Foo_(bar)",
    "xn--e1afmkfd.xn--p1ai": "xn--e1afmkfd.xn--p1ai",
  };
  for (const [input, want] of Object.entries(cases)) {
    assert.deepEqual(texts(input), [want], input);
    assert.deepEqual(urls(input), ["https://" + want], input);
  }
});

test("positives inside sentences, with trailing punctuation and brackets", () => {
  const cases = [
    ["see t.me/x/1.", "t.me/x/1"],
    ["see t.me/x/1, ok", "t.me/x/1"],
    ["is it github.com/a/b?", "github.com/a/b"],
    ["wow example.com!", "example.com"],
    ["(example.com)", "example.com"],
    ["(see example.com/a)", "example.com/a"],
    ["[example.com/a]", "example.com/a"],
    ["\"example.com\"", "example.com"],
    ["'example.com/x'", "example.com/x"],
    ["example.com: yes", "example.com"],
    ["example.com;", "example.com"],
    ["*example.com*", "example.com"],
    ["<example.com>", "example.com"],
    ["example.com/a...", "example.com/a"],
    ["link:\nexample.com/a", "example.com/a"],
    ["example.com. Next", "example.com"],
    ["en.wikipedia.org/wiki/Foo_(bar).", "en.wikipedia.org/wiki/Foo_(bar)"],
    ["(en.wikipedia.org/wiki/Foo_(bar))", "en.wikipedia.org/wiki/Foo_(bar)"],
  ];
  for (const [input, want] of cases) assert.deepEqual(texts(input), [want], JSON.stringify(input));
});

test("several links in one text, in order", () => {
  const m = findBareLinks("a t.me/x and example.com/y, www.foo.org end");
  assert.deepEqual(m.map(x => x.text), ["t.me/x", "example.com/y", "www.foo.org"]);
  assert.equal("a t.me/x and example.com/y, www.foo.org end".slice(m[0].start, m[0].end), "t.me/x");
});

test("negatives: file names, versions, numbers, abbreviations, e-mail, sentences", () => {
  const none = [
    "readme.md", "notes.md", "main.js", "index.py", "foo.sh", "main.rs", "main.rs:42", "setup.py:12:5",
    "Cargo.lock", "package.json", "index.html", "styles.css", "report.pdf", "archive.tar.gz", "photo.jpg",
    "video.mov", "archive.zip", "file.name.txt", "node.js", "Next.js",
    "v1.2.3", "1.2.3", "3.14", "192.168.0.1", "192.168.0.1:8080", "2024.10.04",
    "e.g.", "i.e.", "e.g. this", "U.S.A", "Dr.Smith", "etc.",
    "sentence.Next", "end of sentence.Next", "Wait.No", "Done.Thanks",
    "user@example.com", "first.last@example.com", "mailto:user@example.com", "@example.com",
    "logger.info", "user.id", "this.app", "state.store", "self.me", "obj.is", "a.to", "foo.in",
    "src/main.rs", "a/b.com", "path/to/example.com", "foo_bar.com", "-foo.com", "foo-.com", "foo..com",
    "example.com_x", "example.com@x", "example.COM", "EXAMPLE.COM", "ASP.NET",
    "foo.com:bar", "http://", "localhost", "example", "...", "a.b",
  ];
  for (const s of none) assert.deepEqual(texts(s), [], JSON.stringify(s));
});

test("a host inside an e-mail address, another URL, or an assignment is not re-linked", () => {
  assert.deepEqual(texts("write to me@mail.example.com now"), []);
  assert.deepEqual(texts("ok=1&u=b.com"), []);
  assert.deepEqual(texts("key=value.com"), []);
  assert.deepEqual(texts("x#frag.com"), []);
  assert.deepEqual(texts("user:pw@host.com"), []);
});

test("tiers: weak suffixes need a path; tier 2 needs a port, path, query or fragment", () => {
  assert.deepEqual(texts("example.id"), []);
  assert.deepEqual(texts("example.id/x"), ["example.id/x"]);
  assert.deepEqual(texts("example.id:80"), []);
  assert.deepEqual(texts("t.me"), []);
  assert.deepEqual(texts("t.me/"), ["t.me/"]);
  assert.deepEqual(texts("www.foo.me"), ["www.foo.me"]); // www marks it as a web address
  assert.deepEqual(texts("www.foo.pl"), ["www.foo.pl"]);
  assert.deepEqual(texts("foo.pl"), []);
  assert.deepEqual(texts("foo.unknowntld/x"), []);
});

test("every url is https and parses; nothing but http(s) is ever produced", () => {
  for (const m of findBareLinks("a t.me/x b example.com:81/p?q#f c www.x.org d пример.рф/ж")) {
    assert.match(m.url, /^https:\/\//);
    assert.equal(new URL(m.url).protocol, "https:");
  }
  for (const s of ["javascript:alert(1)", "javascript:alert(1)//a.com", "velta://chat?account=1&chat=2&t=x",
    "data:text/html,a.com/x", "vbscript:a.com/x", "file:///etc/passwd", "ftp://a.com/x", "tel:+1.com"]) {
    for (const m of findBareLinks(s)) assert.match(m.url, /^https:\/\/[^:/]+(:\d+)?(\/|\?|#|$)/, s);
  }
  assert.deepEqual(texts("velta://chat?account=1&chat=2&t=abc.com"), []);
});

test("trimLinkEnd balances brackets and strips sentence punctuation", () => {
  assert.equal(trimLinkEnd("a.com/x)."), "a.com/x");
  assert.equal(trimLinkEnd("a.com/x_(b)"), "a.com/x_(b)");
  assert.equal(trimLinkEnd("a.com/x_(b))"), "a.com/x_(b)");
  assert.equal(trimLinkEnd("a.com/x]"), "a.com/x");
  assert.equal(trimLinkEnd("a.com/[x]"), "a.com/[x]");
  assert.equal(trimLinkEnd("a.com/x!?."), "a.com/x");
  assert.equal(trimLinkEnd("a.com/x\"'"), "a.com/x");
});

test("long adversarial input stays fast", () => {
  const t0 = Date.now();
  findBareLinks("a".repeat(50000));
  findBareLinks("a.".repeat(20000) + "com");
  findBareLinks("a-".repeat(20000));
  findBareLinks("a-".repeat(20000) + ".com");
  findBareLinks("(".repeat(20000) + "a.com/" + ")".repeat(20000));
  trimLinkEnd(")".repeat(50000));
  findBareLinks(("x.y/".repeat(5000)) + "\n" + "example.com ".repeat(2000));
  assert.ok(Date.now() - t0 < 2000);
});

// ---- rendering through renderMarkdown ----

const anchor = (href, label) => `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;

test("renderMarkdown links the issue example with an https href and the typed text", () => {
  assert.equal(
    renderMarkdown("смотри t.me/smysl_doc/10234."),
    "смотри " + anchor("https://t.me/smysl_doc/10234", "t.me/smysl_doc/10234") + ".",
  );
});

test("renderMarkdown leaves non-links untouched and escapes everything", () => {
  assert.equal(renderMarkdown("readme.md v1.2.3 e.g. user@example.com"), "readme.md v1.2.3 e.g. user@example.com");
  assert.equal(renderMarkdown("a <b>y</b>"), "a &lt;b&gt;y&lt;/b&gt;");
  assert.equal(renderMarkdown("a <b>x.com</b>"), "a &lt;b&gt;" + anchor("https://x.com", "x.com") + "&lt;/b&gt;");
  const out = renderMarkdown('x.com/"><script>alert(1)</script>');
  assert.ok(!out.includes("<script"), out);
  assert.match(out, /^<a href="https:\/\/x\.com\/" [^>]*>x\.com\/<\/a>&quot;&gt;&lt;script&gt;/);
  // quotes inside an href are attribute-escaped
  const q = renderMarkdown('x.com/a"b');
  assert.ok(q.includes('href="https://x.com/a&quot;b"') || !q.includes('a"b"'), q);
});

test("renderMarkdown: emphasis around a bare link, underscores inside its path", () => {
  assert.equal(renderMarkdown("**example.com**"), "<strong>" + anchor("https://example.com", "example.com") + "</strong>");
  assert.equal(renderMarkdown("*t.me/a_b_c*"), "<em>" + anchor("https://t.me/a_b_c", "t.me/a_b_c") + "</em>");
  assert.equal(renderMarkdown("t.me/a_b_c and _x_"), anchor("https://t.me/a_b_c", "t.me/a_b_c") + " and <em>x</em>");
});

test("renderMarkdown: existing https links, markdown links and lists behave as before", () => {
  assert.equal(renderMarkdown("https://a.com/x, ok"), anchor("https://a.com/x", "https://a.com/x") + ", ok");
  assert.equal(renderMarkdown("(https://a.com/x)"), "(" + anchor("https://a.com/x", "https://a.com/x") + ")");
  assert.equal(renderMarkdown("[site](https://a.com/x)"), anchor("https://a.com/x", "site"));
  // the label of a markdown link and the URL inside it are not re-linked
  assert.equal(renderMarkdown("[example.com](https://a.com/x)"), anchor("https://a.com/x", "example.com"));
  assert.equal(renderMarkdown("- t.me/x\n- y"), "<ul><li>" + anchor("https://t.me/x", "t.me/x") + "</li><li>y</li></ul>");
  assert.equal(renderMarkdown("> quoted example.com"), "<blockquote>quoted " + anchor("https://example.com", "example.com") + "</blockquote>");
});

test("renderMarkdown: a trailing > after a URL is escaped once", () => {
  assert.equal(renderMarkdown("https://a.com>"), anchor("https://a.com", "https://a.com") + "&gt;");
});

test("renderMarkdown: balanced parentheses stay inside the link", () => {
  assert.equal(
    renderMarkdown("https://en.wikipedia.org/wiki/Foo_(bar)."),
    anchor("https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)") + ".",
  );
});

test("renderMarkdown: scheme-less invite links go through the invite handlers", () => {
  // deltachat.id short links: same card as the https:// form
  const bare = renderMarkdown("deltachat.id/alice");
  const full = renderMarkdown("https://deltachat.id/alice");
  assert.equal(bare, full);
  assert.ok(!bare.includes("javascript:"));
});

test("renderMarkdown: velta:// and javascript: text never become links", () => {
  for (const s of ["velta://chat?account=1&chat=2&t=ab", "javascript:alert(1)", "javascript://x.com/%0aalert(1)"]) {
    const out = renderMarkdown(s);
    assert.ok(!/href="(?!https:)/.test(out), out);
  }
  assert.ok(!renderMarkdown("velta://chat?account=1&chat=2&t=a.com").includes("<a "));
});

test("renderMarkdown: NUL characters in the text cannot forge placeholders", () => {
  assert.equal(renderMarkdown("a\x000\x00b t.me/x"), "a0b " + anchor("https://t.me/x", "t.me/x"));
});
