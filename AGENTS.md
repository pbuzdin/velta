# Velta website — Agent Guide (`website` branch)

## 1. What this branch is

This branch is the GitHub Pages source for **https://velta.cc** (custom domain
via `CNAME`, `.nojekyll`, cert managed by GitHub). It contains ONLY the
website — the application code lives on `master`. Hard rules for anything
shipped here:

- **Zero third parties.** Every asset is vendored and served from velta.cc
  itself: `css/velta.css` + `fonts/` (the design), `admin/elena.js`
  (@elenajs/core). The admin's styles are inline in `admin/index.html`.
  No CDNs, no external fonts, no analytics.
- **No required JavaScript.** Every page is a complete `.html` document
  that renders fully without JS. The only page script is `js/site.js`
  (progressive enhancement: mirrors the news list onto the home page and
  syncs the mobile browser-chrome color to the OS theme) — optional.
  Theming is pure `prefers-color-scheme`; there is no theme UI by choice.
  The CMS under `admin/` is a tool, not a page.
- **Design provenance.** The look comes from a self-contained static
  scaffold (Grok app-builder output, 2026-10-18); the framework around it
  (React/Vite/Vercel/pglite) was discarded. The full original scaffold is
  kept untracked in `design/` (excluded via `.git/info/exclude`) — do not
  commit or deploy it. One exception: `design/index.html` is the published
  design-system page (self-contained snapshot from the main repo's
  `design/velta-design-system.html`), served at https://velta.cc/design/.
- **Privacy sweep before every commit.** The private relay identifiers must
  never enter this (public) branch — run the identifier sweep described in
  the main repo's AGENTS (private relay host/IP/pattern list) and require
  zero hits. Note: the old Sveltia bundle once contained a minified variable
  whose name matched the private relay shorthand; Sveltia is gone, but
  re-check any vendored bundle.

Local checkout: `C:\Users\pave\Velta\velta-website` (separate worktree; the
main checkout stays on master). Shell cwd resets between Bash calls — use
`git -C <path>`.

## 2. Layout

```
index.html                       home: hero, product, features, privacy, platforms, download, news, help, support
about/developing/comparison.html secondary pages (.page)
404.html                         not-found page
news/                            news index + posts (release notes, guide)
_partials/                       nav.html, footer.html (chrome) + reusable blocks — source of truth
css/velta.css                    the design (tokens, light/dark, layout) + generic content layer at the end
fonts/                           self-hosted IBM Plex Sans + Newsreader (woff2)
js/site.js                       news mirror + theme-color sync (progressive enhancement)
v-logo.svg beam-logo.svg favicon.svg
admin/                           elena.js (vendored), backend-github.js (host adapter), admin.js (the CMS), admin.test.mjs
cms/                             the CMS self-description: what it is + the four-operation backend contract
design/                          untracked Grok scaffold + tracked index.html (published design system)
CNAME .nojekyll
```

## 3. The assembly model (read before editing)

The CMS (`admin/admin.js`) is an **assembler** that commits via the GitHub
Contents API. Source of truth is split:

- `_partials/nav.html` / `_partials/footer.html` — shared chrome. Nav links
  carry `data-nav="<key>"`; the assembler swaps the active page's key to
  `aria-current="page"` and strips the rest.
- `_partials/<name>.html` — reusable blocks, pulled into page bodies with
  `<!-- include:name -->` (§4).
- Each page's editable body sits between `<!-- CMS:START -->` /
  `<!-- CMS:END -->`. In the served file this section holds the EXPANDED
  form (includes resolved); in the CMS editor it shows the collapsed form
  (includes as one line).

Consequences:

- **Pages on disk are artifacts.** Saving a page or pressing "Rebuild pages
  from partials" in the CMS regenerates the whole document from partials +
  body. Hand edits to a page's chrome are overwritten by the next assembly —
  chrome belongs to the partials; edit those, then rebuild.
- `<title>`, meta description, the active nav key and the `<main>` class
  (`page` on secondary pages, `news` on the news index, none on home) are
  extracted from the existing page on assembly. To change them, hand-edit
  the page (git) — the CMS preserves but does not edit them.
- **Extensionless links do not work** on GitHub Pages (`/news/slug` 404s);
  always link `news/slug.html`.
- **Wide tables break mobile pages** (seen on `/cms/`, fixed at the content
  layer 2026-10-21): `main.page table` is `display: block; overflow-x: auto`,
  so an over-wide table scrolls in place instead of stretching the page —
  but a phone still has to pan it. Prefer lists for host/option comparisons;
  keep tables to short cells, and put long code paths in `<pre>` blocks.
- Assembly is one commit per file (the Contents API has no batch commit).
- Page `<head>` and head-only files: `404.html` also has body markers and is
  assembled like the rest.

### The CMS at a glance

`/admin/` — sign in with a GitHub PAT (Contents read/write; kept in
localStorage). Reads work signed-out. Four groups:

- **Pages** — the root pages. The editor is a live split: body text left,
  the page rendered with the real site CSS in a sandboxed iframe right
  (debounced while typing, includes expanded, follows the OS theme).
  "Hide/Show preview" toggles the split.
- **News** — `news/index.html` + the posts. "New post" (name, title, type,
  date, summary) creates `news/<name>.html` from the shared post template —
  breadcrumb, kicker, title, date, summary, `div.body`, aside, mirroring the
  existing posts — and inserts the index line at the top of
  `news/index.html` itself, so publishing is one step.
- **Media** — `assets/*`. The editor's "Upload image" button commits the
  file (images only, ≤10 MB, name sanitized and date-stamped) and inserts
  `<img src="/assets/…">` at the cursor. Listed under Media; deletable.
- **Blocks** — `_partials/*`, edited raw; create and delete included
  (nav/footer protected). After changing a block, "Rebuild pages from
  partials" re-applies it to every page.

Commit math: page save = 1 commit, post creation = 2 (the post + its index
line), full rebuild = one per page.

## 4. Include semantics

`<!-- include:name -->` in a body expands at save/rebuild to
`<!-- include:name -->…block content…<!-- /include:name -->`.
One regex with an optional group handles both a bare new directive and a
cached expansion; the editor collapses pairs back to the bare directive.
Unknown names are left as-is (an invisible HTML comment — safe no-op, so a
typo cannot corrupt a page). Deleting a block leaves pages with their last
expanded copy. Deleting `nav.html`/`footer.html` is refused by the CMS.

## 5. Verifying a change

```bash
node admin/admin.test.mjs          # assembler + include engine (mirror of admin.js helpers)
```

- `curl https://velta.cc/` after pushing — curl IS the no-JS test: content
  must be present in the served HTML, zero `<script>` tags on pages.
- `curl` each page for 200; `/nope.html` must return the styled 404.
- Admin smoke: `https://velta.cc/admin/` lists Pages + Blocks, opens a page
  in managed mode.

## 6. Gotchas

- **GitHub Pages serves `max-age: 600`.** After pushing `admin.js`, browsers
  (and the in-app browser) show the stale copy for up to 10 minutes.
  Bump the version query in `admin/index.html` (`admin.js?v=N`) when the
  script changes — that busts every cache deterministically. Module imports
  (`backend-github.js?v=N`) need their own bump when they change.
- **String replacements must use functions** (`raw.replace(re, () => …)`):
  a string replacement interprets `$&` and friends inside user HTML.
- **`_partials/` is publicly served** (a `.nojekyll` site does not hide
  underscore dirs). Accepted — it contains only markup.
- **Last-write-wins.** No draft/PR workflow; a stale PUT 409/422s and the
  CMS reopens the saved version. Assume one editor at a time. Device-local
  drafts are the exception: the editor body persists per path in
  localStorage, is restored on reopen, and is dropped on save and on a
  save conflict (the server version wins).
- **Pushes over SSH fail intermittently** ("access rights") — retry works.
- **Media lives in `assets/`**, uploaded via the CMS (base64 Contents-API
  PUT, one commit per image, ~10 MB practical cap). Reference as
  `<img src="/assets/name">`. Rasters over 1600 px are downscaled to WebP
  automatically on upload; SVG and GIF pass through untouched. Git stores
  every version forever either way.
- **All host access goes through `admin/backend-github.js`** — the
  four-operation contract documented at `/cms/`. Swap that module to run
  the CMS on another git host; nothing else in `admin.js` knows GitHub.
