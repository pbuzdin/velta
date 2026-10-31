// admin.js — minimal GitHub-backed CMS for velta.cc, on elena web components.
//
// The site is fully static: every page is a complete .html document that
// renders without JavaScript. Single source of truth lives in layers:
//   • _partials/nav.html and _partials/footer.html — the shared chrome,
//     edited raw under "Blocks";
//   • any other _partials/*.html — a reusable block, pulled into a page
//     body with <!-- include:name -->. In the editor the include is one
//     line; in the served page it is expanded to the block's current
//     content (wrapped in the same comment pair), so every page save and
//     "Rebuild pages" refreshes includes from the block;
//   • each page's own body, between <!-- CMS:START --> / <!-- CMS:END -->.
// The admin is the assembler: saving a page or rebuilding regenerates the
// full document from partials + body and commits via the GitHub Contents
// API. Pages without markers open in raw mode. Reads work signed-out (the
// repo is public); saving needs a GitHub PAT with Contents read/write,
// kept in localStorage.
//
// ponytail: last-write-wins — no draft/PR workflow; a stale save (file
// changed on the server since it was opened) errors and the editor reopens
// the saved version. Hand edits inside an include pair are overwritten by
// the next save — the block file is the truth; that is the point.

import { Elena, html, nothing } from "./elena.js";
import { createGithubBackend } from "./backend-github.js";
import { planAdd, pageCountOf, pagePath } from "./news-pages.js?v=2";

const REPO = "pbuzdin/velta";
const BRANCH = "website";
const TOKEN_KEY = "velta-admin-token";
const NAV_PARTIAL = "_partials/nav.html";
const FOOTER_PARTIAL = "_partials/footer.html";
const START = "<!-- CMS:START -->";
const END = "<!-- CMS:END -->";
const MARKERS = /<!--\s*CMS:START\s*-->([\s\S]*?)<!--\s*CMS:END\s*-->/;

// <!-- include:name --> optionally followed by the previously expanded
// block content and <!-- /include:name --> — one regex handles both a bare
// new directive and a cached expansion.
const INCLUDE = /<!--\s*include:([a-z0-9-]+)\s*-->([\s\S]*?<!--\s*\/include:\1\s*-->)?/g;

const expandIncludes = (body, blocks) =>
  body.replace(INCLUDE, (m, name) =>
    Object.prototype.hasOwnProperty.call(blocks, name)
      ? `<!-- include:${name} -->\n${blocks[name].trim()}\n<!-- /include:${name} -->`
      : m,
  );

// Editor view: keep only the opening directive; content comes back on save.
const collapseIncludes = (body) =>
  body.replace(/(<!--\s*include:[a-z0-9-]+\s*-->)[\s\S]*?<!--\s*\/include:[a-z0-9-]+\s*-->/g, "$1");

const utf8ToB64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
};

const b64ToUtf8 = (s) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)),
  );

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const isoToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// "2026-10-21" from the date picker → "21 October 2026". Anything that is
// not ISO (a hand-typed date) passes through untouched.
const formatDate = (iso) => {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
  });
};

// News-list category: only "Release" is inferred (titles like "Velta 1.4.87 …");
// other posts get no tag unless one is added by hand (Feature, Guide, Site).
const newsTag = (title) => (/^Velta \d/.test(title) ? "Release" : "");
// One news-index item: whole item is the link; meta line = date · tag;
// the trailing arrow is decorative. Same markup as news/index.html.
const newsListItem = ({ slug, title, summary, date, iso }) => {
  const tag = newsTag(title);
  const meta = `<time datetime="${esc(iso)}">${esc(date)}</time>${tag ? ` · <span class="news-tag">${tag}</span>` : ""}`;
  return `<li><a href="/news/${slug}.html"><span><h2>${esc(title)}<span class="news-arrow" aria-hidden="true">\u00a0→</span></h2><p>${esc(summary)}</p><p class="news-meta">${meta}</p></span></a></li>`;
};
const readMinutes = (text) => Math.max(1, Math.round(text.trim().split(/\s+/).length / 200));

// Camera originals would sit in git forever at full size: downscale any
// raster above 1600 px to a WebP before it becomes a commit. SVG and GIF
// pass through untouched (canvas would rasterize / flatten them). Any
// canvas failure falls back to the original bytes.
const MAX_IMG = 1600;
const fileToB64 = (blob, err) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error(err));
    reader.readAsDataURL(blob);
  });

async function prepImage(file) {
  const dot = file.name.lastIndexOf(".");
  let ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (/^image\/(svg\+xml|gif)$/.test(file.type)) return { base64: await fileToB64(file, "Could not read the file."), ext, resized: false };
  try {
    const bmp = await createImageBitmap(file);
    if (Math.max(bmp.width, bmp.height) > MAX_IMG) {
      const scale = MAX_IMG / Math.max(bmp.width, bmp.height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/webp", 0.85));
      if (blob && blob.size < file.size) {
        return { base64: await fileToB64(blob, "Could not read the resized image."), ext: ".webp", resized: true };
      }
    }
  } catch { /* no canvas support — upload the original */ }
  return { base64: await fileToB64(file, "Could not read the file."), ext, resized: false };
}

// Body of a fresh news post — mirrors the structure of the existing posts
// (breadcrumb, title, date, summary, div.body, aside).
function postBody({ title, date, summary, mins }) {
  return `<p><a href="/news">News</a></p>
<h1>${esc(title)}</h1>
<p><time>${esc(date)}</time> · ${mins} min read</p>
<p>${esc(summary)}</p>
<div class="body">
  <p>Write something.</p>
</div>
<aside>
  <h2>Get the current build</h2>
  <p>The current build for Android, Windows, and macOS, plus notes for a self-hosted browser copy.</p>
  <p><strong><a href="/#download">Download</a></strong></p>
</aside>`;
}

const titleOf = (raw) =>
  ((raw.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "Velta").trim();
const descriptionOf = (raw) =>
  ((raw.match(/name="description" content="([^"]*)"/) || [])[1] || "").trim();
const activeOf = (raw) => {
  const href = (raw.match(/<a href="([^"]+)" aria-current="page"/) || [])[1];
  return href ? href.replace(".html", "").replace("./", "home").replace(/[^a-z0-9-]/g, "") : "";
};
const mainClassOf = (raw) =>
  (raw.match(/<main id="content"(?: class="([^"]*)")?>/) || [])[1] || "";

// The nav partial marks each link with data-nav="<key>"; the active page's
// key becomes aria-current, the rest are stripped so the output stays clean.
function applyActive(nav, active) {
  if (active && nav.includes(` data-nav="${active}"`)) {
    nav = nav.replace(` data-nav="${active}"`, ' aria-current="page"');
  }
  return nav.replace(/ data-nav="[a-z0-9-]+"/g, "");
}

const indent = (block) =>
  block
    .split("\n")
    .map((line) => (line.trim() ? "    " + line : line))
    .join("\n");

// Replacement via function — a string replacement would interpret $& etc.
// in the edited HTML.
const spliceBody = (raw, body) =>
  raw.replace(MARKERS, () => `${START}\n${body.replace(/^\n+|\n+$/g, "")}\n${END}`);

// The assembler: full static page = partials + body (includes expanded).
// Per-page head tags the assembler must keep (canonical / prev / next for
// news pagination, robots on 404): carried over verbatim from the old file.
const headExtraOf = (raw) =>
  (raw.match(/<link rel="(?:canonical|prev|next)"[^>]*>|<meta name="robots"[^>]*>/g) || []).join("\n  ");

function assemble({ nav, footer, body, title, description, active, mainClass, headExtra = "" }) {
  const cls = mainClass ? ` class="${mainClass}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${description}">
  <title>${title}</title>
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0f0f14">
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f4f4f4">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/css/velta.css?v=12">${headExtra ? `\n  ${headExtra}` : ""}
  <script type="speculationrules">
{
  "prerender": [{
    "source": "document",
    "where": { "and": [
      { "href_matches": "/*" },
      { "not": { "href_matches": "/web/*" } },
      { "not": { "href_matches": "/admin/*" } },
      { "not": { "selector": "a[target]" } },
      { "not": { "selector": "a[download]" } }
    ] },
    "eagerness": "moderate" }
  ]
}
  </script>
</head>
<body>
  <a href="#content">Skip to content</a>
${applyActive(nav, active).trimEnd()}
  <main id="content"${cls}>
${START}
${body.replace(/^\n+|\n+$/g, "")}
${END}
  </main>
${footer.trimEnd()}
  <script defer src="/js/site.js?v=7"></script>
</body>
</html>
`;
}

class VeltaAdmin extends Elena(HTMLElement) {
  static tagName = "velta-admin";

  constructor(...args) {
    super(...args);
    this.backend = createGithubBackend({ repo: REPO, branch: BRANCH, getToken: () => this.token });
    this.token = localStorage.getItem(TOKEN_KEY) || "";
    this.files = null; // [{path, name, size, sha, kind: "page"|"block"}], null = loading
    this.current = null; // { path, name, sha }
    this.raw = ""; // whole file on the server
    this.managed = true; // false = raw editing (no markers found)
    this.content = ""; // textarea text: collapsed body, or whole file in raw mode
    this.showPreview = true; // split editor: textarea + live rendered preview
    this.previewTimer = 0;
    this.blocksCache = null; // name -> content, for include expansion in preview
    this.mainClass = "page"; // class of <main id="content"> on the open page
    this.commitMsg = "";
    this.newName = "";
    this.newBlock = "";
    this.newPost = { slug: "", title: "", date: isoToday(), summary: "" };
    this.tokenDraft = "";
    this.status = "";
    this.error = "";
    this.busy = false;
    this.dirty = false; // editor holds edits not yet saved
  }

  firstUpdated() {
    // Event delegation from the light-DOM subtree; text inputs update
    // state silently (no re-render, no focus loss) — only actions and
    // async results call requestUpdate().
    this.addEventListener("click", (e) => this.onAction(e));
    this.addEventListener("input", (e) => this.onInput(e));
    this.addEventListener("change", (e) => {
      if (e.target.id === "image-input") {
        const file = e.target.files && e.target.files[0];
        e.target.value = "";
        if (file) this.uploadImage(file);
      }
    });
    this.loadFiles();
  }

  updated() {
    // Keep the textarea in sync with loaded content without re-rendering
    // it as an attribute (which would clobber the caret).
    const ta = this.querySelector("#editor");
    if (ta && this.current && ta.value !== this.content) ta.value = this.content;
    if (this.current && this.showPreview) this.schedulePreview();
  }

  // Unsaved work survives tab discards (phone browsers do this constantly):
  // the editor body persists per path and is restored on reopen. Cleared on
  // save; on a save conflict the server version wins by design, so the
  // draft goes with it.
  get draftKey() {
    return this.current ? `velta-draft:${this.current.path}` : "";
  }

  // All host access goes through this.backend (the four-operation contract
  // documented at velta.cc/cms/); only this file's wrappers know the CMS
  // prefers text over base64.
  async getRaw(path) {
    const f = await this.backend.get(path);
    return b64ToUtf8(f.content);
  }

  // Guard for every write action: returns true (and shows the error) when
  // signed out.
  needToken(verb) {
    if (this.token) return false;
    this.error = `Sign in first — ${verb} needs a token.`;
    this.requestUpdate();
    return true;
  }

  async putFile(path, message, content, sha, blob = false) {
    // blob: content arrives already base64 (binary upload, e.g. images).
    return this.backend.put(path, message, blob ? content : utf8ToB64(content), sha);
  }

  async deleteFile(path, sha) {
    await this.backend.del(path, `Delete ${path}`, sha);
  }

  // All block contents by name (filename without .html), for include expansion.
  async getBlockMap() {
    const blocks = {};
    for (const f of (this.files || []).filter((f) => f.kind === "block")) {
      blocks[f.name.replace(/\.html$/, "")] = await this.getRaw(f.path);
    }
    return blocks;
  }

  onAction(e) {
    const el = e.target.closest("[data-action]");
    if (!el || !this.contains(el)) return;
    const action = el.dataset.action;
    if (action === "open") this.open(el.dataset.path);
    else if (action === "back") {
      if (this.dirty && !confirm("Leave with unsaved edits? The draft stays on this device and is restored when you reopen the page.")) return;
      this.current = null; this.dirty = false; this.status = ""; this.error = ""; this.requestUpdate();
    }
    else if (action === "save") this.save();
    else if (action === "create") this.create();
    else if (action === "create-post") this.createPost();
    else if (action === "create-block") this.createBlock();
    else if (action === "delete-block") this.deleteBlock(el.dataset.path);
    else if (action === "rebuild") this.rebuildPages();
    else if (action === "toggle-preview") {
      this.showPreview = !this.showPreview;
      this.requestUpdate();
    }
    else if (action === "upload-image") this.querySelector("#image-input").click();
    else if (action === "delete-media") this.deleteMedia(el.dataset.path);
    else if (action === "login") this.login();
    else if (action === "logout") {
      this.token = "";
      localStorage.removeItem(TOKEN_KEY);
      this.status = "Signed out.";
      this.requestUpdate();
    }
  }

  onInput(e) {
    if (e.target.id === "editor") {
      this.content = e.target.value;
      this.dirty = true;
      if (this.draftKey) localStorage.setItem(this.draftKey, this.content);
      this.schedulePreview();
    }
    else if (e.target.id === "commit-msg") this.commitMsg = e.target.value;
    else if (e.target.id === "new-name") this.newName = e.target.value;
    else if (e.target.id === "new-block") this.newBlock = e.target.value;
    else if (e.target.id === "token-draft") this.tokenDraft = e.target.value;
    else if (e.target.id === "post-slug") this.newPost.slug = e.target.value;
    else if (e.target.id === "post-title") this.newPost.title = e.target.value;
    else if (e.target.id === "post-date") this.newPost.date = e.target.value;
    else if (e.target.id === "post-summary") this.newPost.summary = e.target.value;
  }

  // Live preview: the body rendered with the site's real CSS in a sandboxed
  // iframe, includes expanded, debounced while typing.
  schedulePreview() {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.renderPreview(), 400);
  }

  async renderPreview() {
    const frame = this.querySelector("#preview");
    if (!frame || !this.current) return;
    let body = this.content;
    const isPage = this.current.path.endsWith(".html") && !this.current.path.startsWith("_partials/");
    if (this.managed && isPage) {
      try {
        if (!this.blocksCache) this.blocksCache = this.getBlockMap();
        body = expandIncludes(body, await this.blocksCache);
      } catch { /* preview without includes */ }
    }
    frame.srcdoc =
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<link rel="stylesheet" href="/css/velta.css?v=12"><style>body{margin:0;padding:1.25rem}</style></head>` +
      `<body><main id="content"${this.mainClass ? ` class="${this.mainClass}"` : ""}>${body}</main></body></html>`;
  }

  async loadFiles() {
    this.error = "";
    this.files = null;
    this.requestUpdate();
    try {
      const list = await this.backend.list("");
      const files = list
        .filter((f) => f.type === "file" && f.name.endsWith(".html"))
        .map((f) => ({ path: f.name, name: f.name, size: f.size, sha: f.sha, kind: "page" }));
      for (const [dir, kind, htmlOnly] of [
        ["_partials", "block", false],
        ["news", "page", true],
        ["cms", "page", true],
        ["assets", "media", false],
      ]) {
        if (!list.some((d) => d.type === "dir" && d.name === dir)) continue;
        const sub = await this.backend.list(dir);
        files.push(
          ...sub
            .filter((f) => f.type === "file" && (!htmlOnly || f.name.endsWith(".html")))
            .map((f) => ({ path: `${dir}/${f.name}`, name: f.name, size: f.size, sha: f.sha, kind })),
        );
      }
      // News archive pages: news/page-<n>/index.html
      if (files.some((f) => f.path.startsWith("news/"))) {
        const dirs = await this.backend.list("news").then((l) => l.filter((d) => d.type === "dir" && /^page-\d+$/.test(d.name))).catch(() => []);
        for (const d of dirs) {
          for (const f of (await this.backend.list(`news/${d.name}`)).filter((f) => f.type === "file" && f.name === "index.html")) {
            files.push({ path: `news/${d.name}/index.html`, name: d.name, size: f.size, sha: f.sha, kind: "page" });
          }
        }
      }
      files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
      this.files = files;
    } catch (e) {
      this.error = String(e.message || e);
    }
    this.requestUpdate();
  }

  async open(path) {
    this.error = "";
    this.busy = true;
    this.requestUpdate();
    try {
      const f = await this.backend.get(path);
      const raw = b64ToUtf8(f.content);
      const m = raw.match(MARKERS);
      const isPage = path.endsWith(".html") && !path.startsWith("_partials/");
      this.current = { path: f.path, name: f.name, sha: f.sha };
      this.raw = raw;
      this.managed = !!m;
      this.mainClass = isPage ? mainClassOf(raw) : "page";
      this.content = m && isPage ? collapseIncludes(m[1]) : raw;
      this.dirty = false;
      this.commitMsg = "";
      this.status = "";
      const draft = localStorage.getItem(this.draftKey);
      if (draft != null && draft !== this.content) {
        this.content = draft;
        this.dirty = true;
        this.status = "Unsaved draft restored — save to keep it.";
      }
    } catch (e) {
      this.error = String(e.message || e);
    }
    this.busy = false;
    this.requestUpdate();
  }

  async save() {
    if (this.needToken("saving")) return;
    if (!this.current) return;
    const isPage = this.current.path.endsWith(".html") && !this.current.path.startsWith("_partials/");
    this.busy = true;
    this.error = "";
    this.status = "";
    this.requestUpdate();
    try {
      let newRaw;
      if (this.managed && isPage) {
        // Assemble the page fresh from the current partials and blocks.
        const [nav, footer, blocks] = await Promise.all([
          this.getRaw(NAV_PARTIAL),
          this.getRaw(FOOTER_PARTIAL),
          this.getBlockMap(),
        ]);
        newRaw = assemble({
          nav,
          footer,
          body: expandIncludes(this.content, blocks),
          title: titleOf(this.raw),
          description: descriptionOf(this.raw),
          active: activeOf(this.raw),
          mainClass: mainClassOf(this.raw),
          headExtra: headExtraOf(this.raw),
        });
      } else {
        newRaw = this.content;
      }
      const message = this.commitMsg.trim() || `Update ${this.current.path}`;
      this.current.sha = await this.putFile(this.current.path, message, newRaw, this.current.sha);
      this.raw = newRaw;
      if (this.current.path.startsWith("_partials/")) this.blocksCache = null;
      localStorage.removeItem(this.draftKey);
      this.dirty = false;
      this.status = "Saved. Live at velta.cc in about a minute.";
    } catch (e) {
      const m = String(e.message || e);
      if (/sha|conflict|409|422/i.test(m)) {
        this.error = "The file changed on the server since you opened it — reopened the saved version; re-apply your edit.";
        localStorage.removeItem(this.draftKey);
        await this.open(this.current.path);
        return;
      }
      this.error = m;
    }
    this.busy = false;
    this.requestUpdate();
  }

  // Regenerate every page from the current partials and blocks. One commit
  // per page — the Contents API has no multi-file commit.
  async rebuildPages() {
    if (this.needToken("rebuilding")) return;
    this.busy = true;
    this.error = "";
    this.status = "";
    this.requestUpdate();
    try {
      const [nav, footer, blocks] = await Promise.all([
        this.getRaw(NAV_PARTIAL),
        this.getRaw(FOOTER_PARTIAL),
        this.getBlockMap(),
      ]);
      let n = 0;
      for (const f of this.files.filter((f) => f.kind === "page")) {
        const raw = await this.getRaw(f.path);
        const m = raw.match(MARKERS);
        if (!m) continue; // no body markers — not assembled
        const newRaw = assemble({
          nav,
          footer,
          body: expandIncludes(m[1], blocks),
          title: titleOf(raw),
          description: descriptionOf(raw),
          active: activeOf(raw),
          mainClass: mainClassOf(raw),
          headExtra: headExtraOf(raw),
        });
        f.sha = await this.putFile(f.path, `Rebuild ${f.path} from partials`, newRaw, f.sha);
        n++;
      }
      this.status = `Rebuilt ${n} page(s) from the partials.`;
    } catch (e) {
      this.error = String(e.message || e);
    }
    this.busy = false;
    this.requestUpdate();
  }

  async create() {
    const name = this.newName.trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name)) {
      this.error = "Page name: lowercase letters, digits and dashes only.";
      this.requestUpdate();
      return;
    }
    const file = `${name}.html`;
    if ((this.files || []).some((f) => f.path === file)) {
      this.error = `${file} already exists.`;
      this.requestUpdate();
      return;
    }
    if (this.needToken("creating a page")) return;
    this.busy = true;
    this.error = "";
    this.requestUpdate();
    try {
      const [nav, footer] = await Promise.all([
        this.getRaw(NAV_PARTIAL),
        this.getRaw(FOOTER_PARTIAL),
      ]);
      const title = name.replace(/(^|-)([a-z])/g, (m, s, c) => (s ? " " : "") + c.toUpperCase());
      const newRaw = assemble({
        nav,
        footer,
        body: `<h1>${title}</h1>\n<p>Write something.</p>`,
        title: `${title} — Velta`,
        description: `${title} — Velta.`,
        active: "",
        mainClass: "page",
      });
      await this.putFile(file, `Create ${file}`, newRaw, null);
      await this.loadFiles();
      await this.open(file);
      this.status = "Created. Add a nav link in _partials/nav.html (under Blocks), then Rebuild pages.";
    } catch (e) {
      this.error = String(e.message || e);
      this.busy = false;
      this.requestUpdate();
    }
  }

  async createPost() {
    const slug = this.newPost.slug.trim().toLowerCase();
    const title = this.newPost.title.trim();
    const summary = this.newPost.summary.trim() || "Short summary of the post.";
    if (!/^[a-z0-9-]+$/.test(slug)) {
      this.error = "Post name: lowercase letters, digits and dashes only.";
      this.requestUpdate();
      return;
    }
    if (!title) {
      this.error = "A title is required.";
      this.requestUpdate();
      return;
    }
    const path = `news/${slug}.html`;
    if ((this.files || []).some((f) => f.path === path)) {
      this.error = `${path} already exists.`;
      this.requestUpdate();
      return;
    }
    if (this.needToken("publishing")) return;
    this.busy = true;
    this.error = "";
    this.requestUpdate();
    try {
      const [nav, footer] = await Promise.all([
        this.getRaw(NAV_PARTIAL),
        this.getRaw(FOOTER_PARTIAL),
      ]);
      const date = formatDate(this.newPost.date.trim() || isoToday());
      const mins = readMinutes(`${title} ${summary}`);
      const newRaw = assemble({
        nav,
        footer,
        body: postBody({
          title,
          date,
          summary,
          mins,
        }),
        title: `${title} — Velta`,
        description: summary,
        active: "news",
        mainClass: "page",
      });
      await this.putFile(path, `Create ${path}`, newRaw, null);

      // Add the post to /news/ (newest 10) and to the newest archive page
      // (news/page-N/, numbered from the oldest; a full page starts N+1).
      // Older archive pages are never touched — see news-pages.js.
      const indexFile = await this.backend.get("news/index.html");
      const indexRaw = b64ToUtf8(indexFile.content);
      if (!indexRaw.match(MARKERS)) throw new Error("news/index.html has no body markers — cannot add the post to the list.");
      const li = newsListItem({ slug, title, summary, date, iso: this.newPost.date.trim() || isoToday() });
      const pageCount = pageCountOf(indexRaw);
      const newestFile = pageCount ? await this.backend.get(pagePath(pageCount)) : null;
      const writes = planAdd({ indexRaw, newestRaw: newestFile ? b64ToUtf8(newestFile.content) : null, pageCount, li });
      for (const w of writes) {
        const sha = w.path === "news/index.html" ? indexFile.sha : w.create ? null : newestFile.sha;
        await this.putFile(w.path, `Add ${path} to ${w.path}`, w.content, sha);
      }

      await this.loadFiles();
      await this.open(path);
      this.status = "Published and added to the news index — live at velta.cc in about a minute.";
    } catch (e) {
      this.error = String(e.message || e);
      this.busy = false;
      this.requestUpdate();
    }
  }

  // Upload an image to assets/ and drop an <img> at the cursor.
  async uploadImage(file) {
    if (!this.current) return;
    if (!/^image\//.test(file.type)) {
      this.error = "Images only (PNG, JPEG, WebP, SVG).";
      this.requestUpdate();
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      this.error = "Image is over 10 MB — compress it first (git stores every version forever).";
      this.requestUpdate();
      return;
    }
    if (this.needToken("uploading")) return;
    const dot = file.name.lastIndexOf(".");
    const base = (dot >= 0 ? file.name.slice(0, dot) : file.name)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "image";
    this.busy = true;
    this.error = "";
    this.status = "";
    this.requestUpdate();
    try {
      const { base64, ext, resized } = await prepImage(file);
      const name = `assets/${base}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}${ext}`;
      if ((this.files || []).some((f) => f.path === name)) {
        this.error = `${name} already exists — rename the file and try again.`;
        this.busy = false;
        this.requestUpdate();
        return;
      }
      await this.putFile(name, `Add ${name}`, base64, null, true);
      await this.loadFiles();
      const tag = `<img src="/${name}" alt="">`;
      const ta = this.querySelector("#editor");
      const at = ta ? (ta.selectionStart ?? this.content.length) : this.content.length;
      this.content = this.content.slice(0, at) + tag + this.content.slice(ta ? (ta.selectionEnd ?? at) : at);
      if (ta) {
        ta.value = this.content;
        ta.selectionStart = ta.selectionEnd = at + tag.length;
        ta.focus();
      }
      localStorage.setItem(this.draftKey, this.content);
      this.status = `Uploaded ${name}${resized ? " (resized to fit 1600 px)" : ""} — inserted at the cursor.`;
      this.schedulePreview();
    } catch (e) {
      this.error = String(e.message || e);
    }
    this.busy = false;
    this.requestUpdate();
  }

  async deleteMedia(path) {
    const file = (this.files || []).find((f) => f.path === path);
    if (!file) return;
    if (this.needToken("deleting")) return;
    if (!confirm(`Delete ${path}? Pages keep their last published copy until edited; recoverable via git history.`)) return;
    this.busy = true;
    this.error = "";
    this.requestUpdate();
    try {
      await this.deleteFile(path, file.sha);
      await this.loadFiles();
      this.status = `Deleted ${path}.`;
    } catch (e) {
      this.error = String(e.message || e);
    }
    this.busy = false;
    this.requestUpdate();
  }

  async createBlock() {
    const name = this.newBlock.trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name)) {
      this.error = "Block name: lowercase letters, digits and dashes only.";
      this.requestUpdate();
      return;
    }
    const path = `_partials/${name}.html`;
    if ((this.files || []).some((f) => f.path === path)) {
      this.error = `${path} already exists.`;
      this.requestUpdate();
      return;
    }
    if (this.needToken("creating a block")) return;
    this.busy = true;
    this.error = "";
    this.requestUpdate();
    try {
      await this.putFile(path, `Create ${path}`, `<p>Block content.</p>\n`, null);
      await this.loadFiles();
      await this.open(path);
      this.status = `Created. Use <!-- include:${name} --> in a page body; refresh pages via save or Rebuild.`;
    } catch (e) {
      this.error = String(e.message || e);
      this.busy = false;
      this.requestUpdate();
    }
  }

  async deleteBlock(path) {
    if (path === NAV_PARTIAL || path === FOOTER_PARTIAL) {
      this.error = "The nav and footer blocks are the page chrome — they cannot be deleted.";
      this.requestUpdate();
      return;
    }
    const file = (this.files || []).find((f) => f.path === path);
    if (!file) return;
    if (this.needToken("deleting")) return;
    if (!confirm(`Delete ${path}? Pages keep their last expanded copy until rebuilt; recoverable via git history.`)) return;
    this.busy = true;
    this.error = "";
    this.requestUpdate();
    try {
      await this.deleteFile(path, file.sha);
      if (this.current && this.current.path === path) this.current = null;
      await this.loadFiles();
      this.status = `Deleted ${path}.`;
    } catch (e) {
      this.error = String(e.message || e);
    }
    this.busy = false;
    this.requestUpdate();
  }

  login() {
    const t = this.tokenDraft.trim();
    if (!t) {
      this.error = "Paste a token first.";
      this.requestUpdate();
      return;
    }
    this.token = t;
    localStorage.setItem(TOKEN_KEY, t);
    this.tokenDraft = "";
    this.status = "Token saved on this device.";
    this.requestUpdate();
  }

  render() {
    const signedIn = !!this.token;
    return html`
      ${signedIn
        ? html`<p class="admin-bar"><button data-action="logout">Sign out</button><span class="ok">token stored on this device</span></p>`
        : html`<div class="field">
            <label for="token-draft">GitHub token — Contents: read &amp; write, stored on this device</label>
            <p class="admin-bar">
              <input id="token-draft" type="password" autocomplete="off" placeholder="ghp_…" />
              <button class="primary" data-action="login">Sign in</button>
            </p>
          </div>`}
      ${this.busy || this.status || this.error
        ? html`<div class="status-strip" role="status">
            ${this.busy ? html`<span class="ok">Working…</span>` : nothing}
            ${this.status ? html`<span class="ok">${this.status}</span>` : nothing}
            ${this.error ? html`<span class="err">${this.error}</span>` : nothing}
          </div>`
        : nothing}
      ${this.current ? this.renderEditor() : this.renderList()}
    `;
  }

  renderList() {
    const rootPages = (this.files || []).filter((f) => f.kind === "page" && !f.path.startsWith("news/"));
    const newsPages = (this.files || []).filter((f) => f.kind === "page" && f.path.startsWith("news/"));
    const blocks = (this.files || []).filter((f) => f.kind === "block");
    const media = (this.files || []).filter((f) => f.kind === "media");
    const row = (f, deletable) => html`
      <tr>
        <td><button class="path-btn" data-action="open" data-path="${f.path}">${f.path}</button></td>
        <td class="num">${deletable ? html`<button class="danger" data-action="delete-block" data-path="${f.path}">Delete</button>` : html`${f.size} B`}</td>
      </tr>
    `;
    return html`
      <h2>Pages</h2>
      ${this.files === null
        ? html`<p>Loading…</p>`
        : html`
            <table>
              <tbody>
                ${rootPages.map((f) => row(f, false))}
              </tbody>
            </table>
            <p><button data-action="rebuild">Rebuild pages from partials</button></p>
          `}
      <h3>New page</h3>
      <div class="field">
        <label for="new-name">Page name — created as name.html</label>
        <p class="admin-bar">
          <input id="new-name" placeholder="page-name" />
          <button class="primary" data-action="create">Create</button>
        </p>
      </div>
      <p><small>A new page is assembled from the partials with an empty marked body. Add its nav link in the nav block, then rebuild.</small></p>

      <h2>News</h2>
      ${this.files === null
        ? nothing
        : html`
            <table>
              <tbody>
                ${newsPages.map((f) => row(f, false))}
              </tbody>
            </table>
          `}
      <h3>New post</h3>
      <div class="form-grid">
        <div class="field">
          <label for="post-title">Title</label>
          <input id="post-title" placeholder="Velta 1.4.82 …" />
        </div>
        <div class="field">
          <label for="post-slug">Post name — created as news/name.html</label>
          <input id="post-slug" placeholder="post-name" />
        </div>
        <div class="field">
          <label for="post-date">Date</label>
          <input id="post-date" type="date" value="${this.newPost.date}" />
        </div>
      </div>
      <div class="field">
        <label for="post-summary">One-line summary — also the meta description</label>
        <input id="post-summary" placeholder="What changed, in one line" />
      </div>
      <p><button class="primary" data-action="create-post">Create post</button></p>
      <p><small>The post is created from the news template (breadcrumb, kicker, date, summary, body, aside), added to the top of the news index, and the home page list mirrors the index automatically.</small></p>

      <h3>Media</h3>
      ${media.length
        ? html`
            <table>
              <tbody>
                ${media.map(
                  (f) => html`
                    <tr>
                      <td><a href="/${f.path}" target="_blank" rel="noopener">/${f.path}</a></td>
                      <td class="num">${Math.round(f.size / 1024)} KB</td>
                      <td class="num"><button class="danger" data-action="delete-media" data-path="${f.path}">Delete</button></td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
            <p><small>Uploaded images. Reference them anywhere with <code>&lt;img src="/assets/name"&gt;</code>; the Upload image button in the editor does both steps at the cursor.</small></p>
          `
        : html`<p><small>No images yet — the Upload image button in the editor stores them here.</small></p>`}

      <h3>Blocks</h3>
      ${blocks.length
        ? html`
            <table>
              <tbody>
                ${blocks.map((f) => row(f, true))}
              </tbody>
            </table>
            <p><small>Shared chrome and reusable snippets, edited raw. After changing a block, use "Rebuild pages from partials" to apply it to every page. In a body, <code>&lt;!-- include:block-name --&gt;</code> expands to the block's content on save. nav.html and footer.html cannot be deleted.</small></p>
          `
        : nothing}
    `;
  }

  renderEditor() {
    return html`
      <h2>${this.current.path}</h2>
      <p><small>${this.managed
        ? "Editing the marked body section — chrome comes from the partials; <!-- include:name --> lines expand to Blocks on save."
        : "Raw file — no body markers in this file."}</small></p>
      <p class="admin-bar">
        <button class="primary" data-action="save">Save</button>
        <button data-action="back">Back</button>
        <button data-action="toggle-preview">${this.showPreview ? "Hide preview" : "Show preview"}</button>
        <button data-action="upload-image">Upload image</button>
        <input id="image-input" type="file" accept="image/*" hidden />
        <input id="commit-msg" placeholder="Commit message (optional)" />
      </p>
      <div class="editor-grid${this.showPreview ? " split" : ""}">
        <textarea id="editor" spellcheck="false"></textarea>
        ${this.showPreview ? html`<iframe id="preview" sandbox="" title="Preview"></iframe>` : nothing}
      </div>
    `;
  }
}

VeltaAdmin.define();
