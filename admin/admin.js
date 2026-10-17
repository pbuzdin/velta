// admin.js — minimal GitHub-backed CMS for velta.cc, on elena web components.
//
// Edits the `content/*.html` page bodies of the static site: lists the
// folder, loads a file from the `website` branch, edits it in a textarea,
// commits it back via the GitHub Contents API. Reads work signed-out (the
// repo is public); saving needs a GitHub personal access token with
// Contents read/write, kept in localStorage on this origin.
//
// ponytail: last-write-wins — no draft/PR workflow; a stale save (file
// changed on the server since it was opened) 409s and the editor reopens
// the saved version instead of merging. Media uploads not implemented;
// when needed it is a file input plus one more PUT to assets/.

import { Elena, html, nothing } from "./elena.js";

const REPO = "pbuzdin/velta";
const BRANCH = "website";
const API = `https://api.github.com/repos/${REPO}/contents`;
const TOKEN_KEY = "velta-admin-token";

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

class VeltaAdmin extends Elena(HTMLElement) {
  static tagName = "velta-admin";

  constructor(...args) {
    super(...args);
    this.token = localStorage.getItem(TOKEN_KEY) || "";
    this.files = null; // null = loading
    this.current = null; // { name, sha } of the open page
    this.content = "";
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
      const list = await this.api(`/content?ref=${BRANCH}`);
      this.files = list
        .filter((f) => f.type === "file" && f.name.endsWith(".html"))
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
      const f = await this.api(`/content/${name}?ref=${BRANCH}`);
      this.current = { name: f.name, sha: f.sha };
      this.content = b64ToUtf8(f.content);
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
    this.busy = true;
    this.error = "";
    this.status = "";
    this.requestUpdate();
    try {
      const body = { message, content: utf8ToB64(this.content), branch: BRANCH };
      if (this.current.sha) body.sha = this.current.sha;
      const r = await this.api(`/content/${this.current.name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      this.current = { name: this.current.name, sha: r.content.sha };
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
      await this.api(`/content/${file}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Create ${file}`,
          content: utf8ToB64(`<h2>${name}</h2>\n<p>Write something.</p>\n`),
          branch: BRANCH,
        }),
      });
      await this.loadFiles();
      await this.open(file);
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
      <p><small>A new page is served at <code>/#/name</code>; add its nav link by editing index.html (this CMS only edits the page bodies).</small></p>
    `;
  }

  renderEditor() {
    return html`
      <h2>${this.current.name}</h2>
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
