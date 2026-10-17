# Velta website — Agent Guide (`website` branch)

## 1. What this branch is

This branch is the GitHub Pages source for **https://velta.cc** (custom domain
via `CNAME`, `.nojekyll`, cert managed by GitHub). It contains ONLY the
website — the application code lives on `master`. Hard rules for anything
shipped here:

- **Zero third parties.** Every asset is vendored and served from velta.cc
  itself: `css/marx.min.css` (marx-css@5), `admin/elena.js` (@elenajs/core).
  No CDNs, no external fonts, no analytics.
- **Zero page JavaScript.** Every page is a complete `.html` document that
  renders without JS. The only script on the site is the CMS under `admin/`,
  which is a tool, not a page.
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
index.html  about.html  developing.html  comparison.html  404.html   pages (assembled artifacts, see §3)
_partials/      nav.html, footer.html + reusable blocks (source of truth)
css/            marx.min.css (vendored), site.css (aria-current bold)
admin/          elena.js (vendored), admin.js (the CMS), admin.test.mjs
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
- `<title>`, meta description and the active nav key are extracted from the
  existing page on assembly. To change them, hand-edit the page head (git) —
  the CMS preserves but does not edit them.
- Assembly is one commit per file (the Contents API has no batch commit), so
  a rebuild of 5 pages = 5 commits.
- Page `<head>` and head-only files: `404.html` also has body markers and is
  assembled like the rest.

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
  In-page fix: `fetch('admin.js', {cache:'reload'})` then reload.
- **String replacements must use functions** (`raw.replace(re, () => …)`):
  a string replacement interprets `$&` and friends inside user HTML.
- **`_partials/` is publicly served** (a `.nojekyll` site does not hide
  underscore dirs). Accepted — it contains only markup.
- **Last-write-wins.** No draft/PR workflow; a stale PUT 409/422s and the
  CMS reopens the saved version. Assume one editor at a time.
- **Pushes over SSH fail intermittently** ("access rights") — retry works.
- **No media uploads.** Screenshots etc. are committed by hand; an upload
  feature would be a file input plus one more PUT.
