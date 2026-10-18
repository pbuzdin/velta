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

const REPO = "pbuzdin/velta";
const BRANCH = "website";
const API = `https://api.github.com/repos/${REPO}/contents`;
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

const today = () =>
  new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

// Body of a fresh news post — mirrors the structure of the existing posts
// (breadcrumb, kicker, title, date, summary, div.body, aside).
function postBody({ title, kicker, date, summary }) {
  return `<p><a href="/news">News</a></p>
<p class="kicker">${esc(kicker)}</p>
<h1>${esc(title)}</h1>
<p><time>${esc(date)}</time> · 3 min read</p>
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
function assemble({ nav, footer, body, title, description, active, mainClass }) {
  const cls = mainClass ? ` class="${mainClass}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${description}">
  <title>${title}</title>
  <meta name="theme-color" content="#0f0f14">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/css/velta.css">
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
  <script src="/js/site.js"></script>
</body>
</html>
`;
}

class VeltaAdmin extends Elena(HTMLElement) {
  static tagName = "velta-admin";

  constructor(...args) {
    super(...args);
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
    this.newPost = { slug: "", title: "", kicker: "Release", date: today(), summary: "" };
    this.tokenDraft = "";
    this.status = "";
    this.error = "";
    this.busy = false;
  }

  firstUpdated() {
    // Event delegation from the light-DOM subtree; text inputs update
    // state silently (no re-render, no focus loss) — only actions and
    // async results call requestUpdate().
    this.addEventListener("click", (e) => this.onAction(e));
    this.addEventListener("input", (e) => this.onInput(e));
    this.loadFiles();
  }

  updated() {
    // Keep the textarea in sync with loaded content without re-rendering
    // it as an attribute (which would clobber the caret).
    const ta = this.querySelector("#editor");
    if (ta && this.current && ta.value !== this.content) ta.value = this.content;
    if (this.current && this.showPreview) this.schedulePreview();
  }

  async api(path, opts = {}) {
    const headers = { Accept: "application/vnd.github+json", ...opts.headers };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(`${API}${path}`, { ...opts, headers });
    if (!res.ok) {
      let msg = `GitHub API ${res.status}`;
      try {
        const j = await res.json();
        if (j.message) msg = j.message;
      } catch {}
      if (res.status === 401) msg = "Unauthorized — the token is missing or lacks Contents read/write.";
      throw new Error(msg);
    }
    return res.json();
  }

  async getRaw(path) {
    const f = await this.api(`/${path}?ref=${BRANCH}`);
    return b64ToUtf8(f.content);
  }

  async putFile(path, message, content, sha) {
    const body = { message, content: utf8ToB64(content), branch: BRANCH };
    if (sha) body.sha = sha;
    const r = await this.api(`/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.content.sha;
  }

  async deleteFile(path, sha) {
    await this.api(`/${path}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `Delete ${path}`, sha, branch: BRANCH }),
    });
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
    else if (action === "back") { this.current = null; this.status = ""; this.error = ""; this.requestUpdate(); }
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
    else if (action === "login") this.login();
    else if (action === "logout") {
      this.token = "";
      localStorage.removeItem(TOKEN_KEY);
      this.status = "Signed out.";
      this.requestUpdate();
    }
  }

  onInput(e) {
    if (e.target.id === "editor") { this.content = e.target.value; this.schedulePreview(); }
    else if (e.target.id === "commit-msg") this.commitMsg = e.target.value;
    else if (e.target.id === "new-name") this.newName = e.target.value;
    else if (e.target.id === "new-block") this.newBlock = e.target.value;
    else if (e.target.id === "token-draft") this.tokenDraft = e.target.value;
    else if (e.target.id === "post-slug") this.newPost.slug = e.target.value;
    else if (e.target.id === "post-title") this.newPost.title = e.target.value;
    else if (e.target.id === "post-kicker") this.newPost.kicker = e.target.value;
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
    const theme = document.documentElement.getAttribute("data-theme");
    frame.srcdoc =
      `<!doctype html><html lang="en"${theme ? ` data-theme="${theme}"` : ""}><head><meta charset="utf-8">` +
      `<link rel="stylesheet" href="/css/velta.css"><style>body{margin:0;padding:1.25rem}</style></head>` +
      `<body><main id="content"${this.mainClass ? ` class="${this.mainClass}"` : ""}>${body}</main></body></html>`;
  }

  async loadFiles() {
    this.error = "";
    this.files = null;
    this.requestUpdate();
    try {
      const list = await this.api(`?ref=${BRANCH}`);
      const files = list
        .filter((f) => f.type === "file" && f.name.endsWith(".html"))
        .map((f) => ({ path: f.name, name: f.name, size: f.size, sha: f.sha, kind: "page" }));
      const partialsDir = list.find((d) => d.type === "dir" && d.name === "_partials");
      if (partialsDir) {
        const sub = await this.api(`/_partials?ref=${BRANCH}`);
        files.push(
          ...sub
            .filter((f) => f.type === "file")
            .map((f) => ({ path: `_partials/${f.name}`, name: f.name, size: f.size, sha: f.sha, kind: "block" })),
        );
      }
      const newsDir = list.find((d) => d.type === "dir" && d.name === "news");
      if (newsDir) {
        const sub = await this.api(`/news?ref=${BRANCH}`);
        files.push(
          ...sub
            .filter((f) => f.type === "file" && f.name.endsWith(".html"))
            .map((f) => ({ path: `news/${f.name}`, name: f.name, size: f.size, sha: f.sha, kind: "page" })),
        );
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
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
      const f = await this.api(`/${path}?ref=${BRANCH}`);
      const raw = b64ToUtf8(f.content);
      const m = raw.match(MARKERS);
      const isPage = path.endsWith(".html") && !path.startsWith("_partials/");
      this.current = { path: f.path, name: f.name, sha: f.sha };
      this.raw = raw;
      this.managed = !!m;
      this.mainClass = isPage ? mainClassOf(raw) : "page";
      this.content = m && isPage ? collapseIncludes(m[1]) : raw;
      this.commitMsg = "";
      this.status = "";
    } catch (e) {
      this.error = String(e.message || e);
    }
    this.busy = false;
    this.requestUpdate();
  }

  async save() {
    if (!this.token) {
      this.error = "Sign in first — saving needs a token.";
      this.requestUpdate();
      return;
    }
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
        });
      } else {
        newRaw = this.content;
      }
      const message = this.commitMsg.trim() || `Update ${this.current.path}`;
      this.current.sha = await this.putFile(this.current.path, message, newRaw, this.current.sha);
      this.raw = newRaw;
      if (this.current.path.startsWith("_partials/")) this.blocksCache = null;
      this.status = "Saved. Live at velta.cc in about a minute.";
    } catch (e) {
      const m = String(e.message || e);
      if (/sha|conflict|409|422/i.test(m)) {
        this.error = "The file changed on the server since you opened it — reopened the saved version; re-apply your edit.";
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
    if (!this.token) {
      this.error = "Sign in first — rebuilding needs a token.";
      this.requestUpdate();
      return;
    }
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
    if (!this.token) {
      this.error = "Sign in first — creating a page needs a token.";
      this.requestUpdate();
      return;
    }
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
        body: `<p class="kicker">Project</p>\n<h1>${title}</h1>\n<p>Write something.</p>`,
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
    if (!this.token) {
      this.error = "Sign in first — publishing needs a token.";
      this.requestUpdate();
      return;
    }
    this.busy = true;
    this.error = "";
    this.requestUpdate();
    try {
      const [nav, footer] = await Promise.all([
        this.getRaw(NAV_PARTIAL),
        this.getRaw(FOOTER_PARTIAL),
      ]);
      const newRaw = assemble({
        nav,
        footer,
        body: postBody({
          title,
          kicker: this.newPost.kicker,
          date: this.newPost.date.trim() || today(),
          summary,
        }),
        title: `${title} — Velta`,
        description: summary,
        active: "news",
        mainClass: "page",
      });
      await this.putFile(path, `Create ${path}`, newRaw, null);
      await this.loadFiles();
      await this.open(path);
      this.status = "Published as a draft on the site. Add a line for it to the news index (news/index.html) so it shows up in the lists.";
    } catch (e) {
      this.error = String(e.message || e);
      this.busy = false;
      this.requestUpdate();
    }
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
    if (!this.token) {
      this.error = "Sign in first — creating a block needs a token.";
      this.requestUpdate();
      return;
    }
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
    if (!this.token) {
      this.error = "Sign in first — deleting needs a token.";
      this.requestUpdate();
      return;
    }
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
      <p class="admin-bar">
        ${signedIn
          ? html`<button data-action="logout">Sign out</button><span class="ok">token stored on this device</span>`
          : html`<input id="token-draft" type="password" autocomplete="off"
                placeholder="GitHub token (Contents: read &amp; write)" /><button data-action="login">Sign in</button>`}
      </p>
      ${this.busy ? html`<p class="ok">Working…</p>` : nothing}
      ${this.current ? this.renderEditor() : this.renderList()}
      ${this.status ? html`<p class="ok">${this.status}</p>` : nothing}
      ${this.error ? html`<p class="err">${this.error}</p>` : nothing}
    `;
  }

  renderList() {
    const rootPages = (this.files || []).filter((f) => f.kind === "page" && !f.path.startsWith("news/"));
    const newsPages = (this.files || []).filter((f) => f.kind === "page" && f.path.startsWith("news/"));
    const blocks = (this.files || []).filter((f) => f.kind === "block");
    const row = (f, deletable) => html`
      <tr>
        <td><button data-action="open" data-path="${f.path}">${f.path}</button></td>
        <td>${deletable ? html`<button data-action="delete-block" data-path="${f.path}">Delete</button>` : html`${f.size} B`}</td>
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
      <p>
        <input id="new-name" placeholder="page-name" /> .html
        <button data-action="create">Create</button>
      </p>
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
      <p class="admin-bar">
        <input id="post-slug" placeholder="post-name" /> .html
        <input id="post-title" placeholder="Title" />
        <select id="post-kicker">
          <option>Release</option>
          <option>Guide</option>
          <option>Note</option>
        </select>
        <input id="post-date" value="${this.newPost.date}" />
      </p>
      <p><input id="post-summary" placeholder="One-line summary (also the meta description)" /></p>
      <p><button data-action="create-post">Create post</button></p>
      <p><small>The post is created from the news template (breadcrumb, kicker, date, summary, body, aside) with "News" marked current in the nav. Then add a line for it to the news index (news/index.html) — the home page mirrors that list automatically.</small></p>

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
        <button data-action="save">Save</button>
        <button data-action="back">Back</button>
        <button data-action="toggle-preview">${this.showPreview ? "Hide preview" : "Show preview"}</button>
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
