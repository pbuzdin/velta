// admin.js — minimal GitHub-backed CMS for velta.cc, on elena web components.
//
// The site is fully static: every page is a complete .html document that
// renders without JavaScript. Single source of truth lives in two layers:
//   • _partials/nav.html and _partials/footer.html — the shared chrome,
//     edited raw under "Blocks";
//   • each page's body, between <!-- CMS:START --> / <!-- CMS:END -->.
// The admin is the assembler: saving a page or hitting "Rebuild pages"
// regenerates the full document from partials + body and commits it via
// the GitHub Contents API. Pages without markers open in raw mode (whole
// file in the textarea). Reads work signed-out (the repo is public);
// saving needs a GitHub PAT with Contents read/write, kept in localStorage.
//
// ponytail: last-write-wins — no draft/PR workflow; a stale save (file
// changed on the server since it was opened) errors and the editor reopens
// the saved version. Hand edits to a page's chrome are overwritten by the
// next assembly — chrome belongs to the partials; that is the point.

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

const titleOf = (raw) =>
  ((raw.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "Velta").trim();
const descriptionOf = (raw) =>
  ((raw.match(/name="description" content="([^"]*)"/) || [])[1] || "").trim();
const activeOf = (raw) => {
  const href = (raw.match(/<a href="([^"]+)" aria-current="page"/) || [])[1];
  return href ? href.replace(".html", "").replace("./", "home").replace(/[^a-z0-9-]/g, "") : "";
};

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

// The assembler: full static page = partials + body.
function assemble({ nav, footer, body, title, description, active }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${description}">
  <title>${title}</title>
  <link rel="stylesheet" href="css/marx.min.css">
  <link rel="stylesheet" href="css/site.css">
</head>
<body>
  <main class="container">
${indent(applyActive(nav, active).trimEnd())}
    <article>
${START}
${body.replace(/^\n+|\n+$/g, "")}
${END}
    </article>
${indent(footer.trimEnd())}
  </main>
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
    this.content = ""; // textarea text: body section, or whole file in raw mode
    this.commitMsg = "";
    this.newName = "";
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

  onAction(e) {
    const el = e.target.closest("[data-action]");
    if (!el || !this.contains(el)) return;
    const action = el.dataset.action;
    if (action === "open") this.open(el.dataset.path);
    else if (action === "back") { this.current = null; this.status = ""; this.error = ""; this.requestUpdate(); }
    else if (action === "save") this.save();
    else if (action === "create") this.create();
    else if (action === "rebuild") this.rebuildPages();
    else if (action === "login") this.login();
    else if (action === "logout") {
      this.token = "";
      localStorage.removeItem(TOKEN_KEY);
      this.status = "Signed out.";
      this.requestUpdate();
    }
  }

  onInput(e) {
    if (e.target.id === "editor") this.content = e.target.value;
    else if (e.target.id === "commit-msg") this.commitMsg = e.target.value;
    else if (e.target.id === "new-name") this.newName = e.target.value;
    else if (e.target.id === "token-draft") this.tokenDraft = e.target.value;
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
      this.current = { path: f.path, name: f.name, sha: f.sha };
      this.raw = raw;
      this.managed = !!m;
      this.content = m ? m[1] : raw;
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
        // Assemble the page fresh from the current partials.
        const [nav, footer] = await Promise.all([
          this.getRaw(NAV_PARTIAL),
          this.getRaw(FOOTER_PARTIAL),
        ]);
        newRaw = assemble({
          nav,
          footer,
          body: this.content,
          title: titleOf(this.raw),
          description: descriptionOf(this.raw),
          active: activeOf(this.raw),
        });
      } else {
        newRaw = this.content;
      }
      const message = this.commitMsg.trim() || `Update ${this.current.path}`;
      this.current.sha = await this.putFile(this.current.path, message, newRaw, this.current.sha);
      this.raw = newRaw;
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

  // Regenerate every page from the current partials. One commit per page —
  // the Contents API has no multi-file commit.
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
      const [nav, footer] = await Promise.all([
        this.getRaw(NAV_PARTIAL),
        this.getRaw(FOOTER_PARTIAL),
      ]);
      let n = 0;
      for (const f of this.files.filter((f) => f.kind === "page")) {
        const raw = await this.getRaw(f.path);
        const m = raw.match(MARKERS);
        if (!m) continue; // no body markers — not assembled
        const newRaw = assemble({
          nav,
          footer,
          body: m[1],
          title: titleOf(raw),
          description: descriptionOf(raw),
          active: activeOf(raw),
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
        body: `<h2>${title}</h2>\n<p>Write something.</p>`,
        title: `${title} — Velta`,
        description: `${title} — Velta.`,
        active: "",
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
    const pages = (this.files || []).filter((f) => f.kind === "page");
    const blocks = (this.files || []).filter((f) => f.kind === "block");
    return html`
      <h2>Pages</h2>
      ${this.files === null
        ? html`<p>Loading…</p>`
        : html`
            <table>
              <tbody>
                ${pages.map(
                  (f) => html`
                    <tr>
                      <td><button data-action="open" data-path="${f.path}">${f.name}</button></td>
                      <td>${f.size} B</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
            <p><button data-action="rebuild">Rebuild pages from partials</button></p>
          `}
      <h3>Blocks</h3>
      ${blocks.length
        ? html`
            <table>
              <tbody>
                ${blocks.map(
                  (f) => html`
                    <tr>
                      <td><button data-action="open" data-path="${f.path}">${f.path}</button></td>
                      <td>${f.size} B</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
            <p><small>Shared chrome, edited raw. After changing a block, use "Rebuild pages from partials" to apply it to every page.</small></p>
          `
        : nothing}
      <h3>New page</h3>
      <p>
        <input id="new-name" placeholder="page-name" /> .html
        <button data-action="create">Create</button>
      </p>
      <p><small>A new page is assembled from the partials with an empty marked body. Add its nav link in the nav block, then rebuild.</small></p>
    `;
  }

  renderEditor() {
    return html`
      <h2>${this.current.path}</h2>
      <p><small>${this.managed ? "Editing the marked body section — the page chrome comes from the partials." : "Raw file — no body markers in this file."}</small></p>
      <p class="admin-bar">
        <button data-action="save">Save</button>
        <button data-action="back">Back</button>
        <input id="commit-msg" placeholder="Commit message (optional)" />
      </p>
      <textarea id="editor" spellcheck="false"></textarea>
    `;
  }
}

VeltaAdmin.define();
