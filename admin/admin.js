// admin.js — minimal GitHub-backed CMS for velta.cc, on elena web components.
//
// The site is fully static: every page is a complete .html document with the
// header/nav/footer baked in, and the editable body sits between
// <!-- CMS:START --> and <!-- CMS:END --> markers. This admin lists the
// pages, shows just that section in the textarea, and commits the whole
// file back via the GitHub Contents API. Pages without markers open in raw
// mode (the whole file in the textarea). Reads work signed-out (the repo is
// public); saving needs a GitHub PAT with Contents read/write, kept in
// localStorage on this origin.
//
// ponytail: last-write-wins — no draft/PR workflow; a stale save (file
// changed on the server since it was opened) errors and the editor reopens
// the saved version instead of merging. The nav is baked into every page,
// so a page created here must be linked by hand in the others.

import { Elena, html, nothing } from "./elena.js";

const REPO = "pbuzdin/velta";
const BRANCH = "website";
const API = `https://api.github.com/repos/${REPO}/contents`;
const TOKEN_KEY = "velta-admin-token";
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

// Replacement via function — a string replacement would interpret $& etc.
// in the edited HTML.
const spliceBody = (raw, body) =>
  raw.replace(MARKERS, () => `${START}\n${body.replace(/^\n+|\n+$/g, "")}\n${END}`);

// A complete static page with the shared chrome and empty markers, ready
// for the editor.
function pageTemplate(name) {
  const title = name.replace(/(^|[-])([a-z])/g, (m, s, c) => (s ? " " : "") + c.toUpperCase());
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${title} — Velta.">
  <title>${title} — Velta</title>
  <link rel="stylesheet" href="css/marx.min.css">
  <link rel="stylesheet" href="css/site.css">
</head>
<body>
  <main class="container">
    <header>
      <h1><a href="./" style="text-decoration:none;color:inherit">Velta</a></h1>
      <p>
        <a href="./">Home</a> ·
        <a href="developing.html">Developing</a> ·
        <a href="comparison.html">Compare</a> ·
        <a href="about.html">About</a> ·
        <a href="https://github.com/pbuzdin/velta/releases">Download</a> ·
        <a href="admin/">Edit</a>
      </p>
      <hr>
    </header>
    <article>
${START}
<h2>${title}</h2>
<p>Write something.</p>
${END}
    </article>
    <footer>
      <hr>
      <p>© 2026 Velta</p>
    </footer>
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
    this.files = null; // null = loading
    this.current = null; // { name, sha }
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

  onAction(e) {
    const el = e.target.closest("[data-action]");
    if (!el || !this.contains(el)) return;
    const action = el.dataset.action;
    if (action === "open") this.open(el.dataset.name);
    else if (action === "back") { this.current = null; this.status = ""; this.error = ""; this.requestUpdate(); }
    else if (action === "save") this.save();
    else if (action === "create") this.create();
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
      this.files = list
        .filter((f) => f.type === "file" && f.name.endsWith(".html") && f.name !== "404.html")
        .map((f) => ({ name: f.name, size: f.size }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      this.error = String(e.message || e);
    }
    this.requestUpdate();
  }

  async open(name) {
    this.error = "";
    this.busy = true;
    this.requestUpdate();
    try {
      const f = await this.api(`/${name}?ref=${BRANCH}`);
      const raw = b64ToUtf8(f.content);
      const m = raw.match(MARKERS);
      this.current = { name: f.name, sha: f.sha };
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
    const message = this.commitMsg.trim() || `Update ${this.current.name}`;
    const newRaw = this.managed ? spliceBody(this.raw, this.content) : this.content;
    this.busy = true;
    this.error = "";
    this.status = "";
    this.requestUpdate();
    try {
      const body = { message, content: utf8ToB64(newRaw), branch: BRANCH };
      if (this.current.sha) body.sha = this.current.sha;
      const r = await this.api(`/${this.current.name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      this.current = { name: this.current.name, sha: r.content.sha };
      this.raw = newRaw;
      this.status = "Saved. Live at velta.cc in about a minute.";
    } catch (e) {
      const m = String(e.message || e);
      if (/sha|conflict|409|422/i.test(m)) {
        this.error = "The file changed on the server since you opened it — reopened the saved version; re-apply your edit.";
        await this.open(this.current.name);
        return;
      }
      this.error = m;
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
    if ((this.files || []).some((f) => f.name === file)) {
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
      await this.api(`/${file}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Create ${file}`,
          content: utf8ToB64(pageTemplate(name)),
          branch: BRANCH,
        }),
      });
      await this.loadFiles();
      await this.open(file);
      this.status = "Created. Add its nav link to the other pages — the nav is baked into each one.";
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
    return html`
      <h2>Pages</h2>
      ${this.files === null
        ? html`<p>Loading…</p>`
        : html`
            <table>
              <tbody>
                ${this.files.map(
                  (f) => html`
                    <tr>
                      <td><button data-action="open" data-name="${f.name}">${f.name}</button></td>
                      <td>${f.size} B</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
      <h3>New page</h3>
      <p>
        <input id="new-name" placeholder="page-name" /> .html
        <button data-action="create">Create</button>
      </p>
      <p><small>A new page is created as a complete document with the shared chrome; the editor opens its marked body section. Link it from the other pages — the nav is baked into each one.</small></p>
    `;
  }

  renderEditor() {
    return html`
      <h2>${this.current.name}</h2>
      <p><small>${this.managed ? "Editing the marked body section — the page chrome stays untouched." : "No markers found — editing the whole file."}</small></p>
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
