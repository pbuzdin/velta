# Managing velta.cc with the CMS

The site is fully static — every page is a complete HTML document. The CMS
at [velta.cc/admin](https://velta.cc/admin/) is the one tool that edits it:
it stores your edits as commits to the `website` branch of
[pbuzdin/velta](https://github.com/pbuzdin/velta), and GitHub Pages publishes
them about a minute later.

## Sign in

1. Create a GitHub token with **Contents: read and write** permission (the
   login dialog links to GitHub with permissions pre-selected).
2. Paste it under the sign-in field and press **Sign in**. It is stored in
   your browser's localStorage on velta.cc only. **Sign out** removes it.

Reading (the page and block lists, opening files) works without a token —
the repo is public. Saving, creating, deleting and rebuilding need it.

## Pages

Everything under **Pages** is editable — the home page (`index.html`), the
secondary pages (`about.html`, `developing.html`, `comparison.html`,
`404.html`) and the news posts (`news/….html`). Opening one shows only the
editable body — the header, navigation and footer come from the shared
blocks and are assembled around your text on every save.

Page bodies start with a `<p class="kicker">…</p>` line and an `<h1>` title
(the home page is one long page of sections instead).

- **Save** commits the page. Around a minute later it is live.
- **Live preview** — the editor is split: text left, the body rendered with
  the site's real CSS right (includes expanded, debounced while you type,
  follows your OS light/dark preference). "Hide/Show preview" toggles the
  split.
- The commit message field is optional; a default is used otherwise.
- The page title and description are *not* edited in the CMS — change them
  in the page's `<head>` via git, or ask a maintainer.
- **Rebuild pages from partials** regenerates every page from the current
  blocks. Use it after editing a block (below).

## Blocks and includes

Under **Blocks** you manage shared snippets in `_partials/`:

- `nav.html` and `footer.html` are the page chrome. They cannot be deleted.
  After changing them, press **Rebuild pages from partials** to apply the
  change to every page (this creates one small commit per page).
- Any other block is a reusable snippet. Create one with the **Create block**
  form, edit it like a page (raw), delete it with its **Delete** button
  (recoverable via git history).

To use a block inside a page, write this line in the page body:

```
<!-- include:block-name -->
```

On save it expands to the block's current content. In the editor you always
see just the one line — edit the block, not the expanded copy. If you delete
a block, pages keep their last expanded copy until you remove the line.
A typo'd include name stays an invisible comment — nothing breaks.

**Recipe — a "downloads" snippet used on two pages:** create the block
`downloads`, put the list there, write `<!-- include:downloads -->` in both
page bodies, save each page. Later edits: change the block, press
**Rebuild pages from partials** — done.

## New page

1. **New page** → name (lowercase letters, digits, dashes) → **Create**.
   A complete page is assembled with an empty body and opened for editing.
2. Add it to the navigation: open the `nav.html` block, copy one of the
   `<a href="...">` lines for your page, save the block.
3. **Rebuild pages from partials** so every page's navigation picks it up.

## New news post

News posts live in their own **News** group and use the shared post template
(breadcrumb, kicker, title, date, summary, body, aside) — the same structure
as the existing posts.

1. **New post** → fill in the name, title, type (Release / Guide / Note),
   date (pre-filled with today) and a one-line summary → **Create post**.
   The post is created **and** added to the top of the news index in the
   same go — the home page list mirrors the index automatically.
2. The post opens in the editor — write the body inside `div.body`.
   The preview shows it with the site's real styling. Save when done.

## Limits and recovery

- Everything is git — any mistake is recoverable from the `website` branch
  history on GitHub.
- There is no draft mode: saving publishes (within ~1 minute). If two people
  save the same page at once, the second save is rejected and the editor
  reloads the stored version; re-apply your edit.
- No image uploads yet — commit media by hand and reference it.
- The CMS itself lives in `admin/admin.js` (see `AGENTS.md` for internals
  and `admin/admin.test.mjs` for its test suite).
