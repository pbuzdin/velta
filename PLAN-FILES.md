# Plan: opening real file attachments externally on Android (pdf/doc/etc.)

Status: planned (not started). Estimate: ~1 day including device verification.
Depends on nothing else in flight; the media half of the problem is already
shipped (see "Already done" below).

## Background

User report (v1.4.33 era): tapping open on an animated webp on Android toasted
`Could not open file: Cannot construct instance of app.tauri.opener.OpenArgs
... no String-argument constructor`. Root cause verified in
tauri-plugin-opener 2.5.4: the Kotlin plugin (`OpenerPlugin.kt`) implements
only the URL command — `open_path` has no mobile implementation, the path
string reaches `OpenArgs` deserialization and crashes. Independently of the
plugin, app-private paths (`/data/user/0/org.velta/...`) cannot be opened by
other Android apps at all without a FileProvider grant.

Interim state shipped in ae061db: `_openFile` on Android routes media files
(png/jpg/gif/webp/bmp/avif, via `isMediaFilePath`) into the image lightbox and
toasts "Opening this file type isn't supported on Android yet" for everything
else. No crash, but pdf/doc/etc. are still unopenable on Android.

## Goal

Tapping a real file attachment (pdf, doc, xls, apk, …) on Android offers the
system picker: ACTION_VIEW / chooser with a content:// URI the receiving app
is allowed to read. Desktop and PWA behavior unchanged (desktop keeps the
opener plugin, which works there).

## Design

### The provider already exists

`gen/android/app/src/main/AndroidManifest.xml` declares
`androidx.core.content.FileProvider` with authority `${applicationId}.fileprovider`
(`grantUriPermissions="true"`, not exported) and
`@xml/file_paths`. What is missing is coverage for the accounts directory and
anyone actually minting URIs.

Current `res/xml/file_paths.xml` covers only:

```xml
<external-path name="my_images" path="." />
<cache-path name="my_cache_images" path="." />
```

### Recommended route: share from cache (Option A)

`cache-path` is already covered. At open time:

1. Copy the source file from the accounts dir to `cacheDir/opens/<name>`
   (deduped by name+size; clear the folder on app start to bound growth).
2. `FileProvider.getUriForFile(context, "${applicationId}.fileprovider", f)`
   → content:// URI valid for `cache-path` entries.
3. `Intent(ACTION_VIEW)` `setDataAndType(uri, mime)` +
   `FLAG_GRANT_READ_URI_PERMISSION`; wrap in `Intent.createChooser`.
4. No app resolves the mime → toast "No app can open this file".

Why this route: zero manifest/paths changes (no release-configuration risk on
the `gen/` tree), bounded exposure (only files we explicitly copied are ever
shareable), and cacheDir is system-manageable. Cost: one copy of typically
small documents; acceptable. For huge files we can revisit:

Alternative (Option B, not recommended now): add
`<root-path name="data" path="data/user/0/org.velta/" />` to file_paths.xml
and mint URIs straight from the blobs dir. No copy, but root-path entries are
discouraged by the Android docs and the authority covers a wide tree.

### Wiring (follows two existing in-repo patterns)

- New Kotlin method in `OpenerPlugin`-style file — but our own: add
  `openAttachment(path: String, mime: String)` to a new small
  `AttachmentOpener.kt` (or extend InAppBrowser.kt's file) registered in
  MainActivity next to InAppBrowser, following the
  `APP_CONTEXT`/`APP_JAVA_VM` hand-over pattern.
- Rust command `open_attachment(path, name)` (cfg android), shaped like
  `open_in_app_browser` (lib.rs): resolve the relative blob path under the
  accounts dir (same canonicalize-and-prefix check the blobfile protocol
  uses), hand path+mime to Kotlin via JNI. Non-Android builds keep the
  existing opener-plugin path in `_openFile`.
- MIME: derive in Rust from `guess_mime()` (already central) and pass it
  over; Android `MimeTypeMap` fallback for the chooser.
- Frontend `_openFile` (chat-view.js): Android branch currently ends in the
  honest toast; extend it — media → lightbox (unchanged), other types →
  `invoke("open_attachment", { path, name })`, falling back to the toast when
  the command is missing (older shell + newer frontend can't happen — they
  ship in the same APK — but keep the catch).

### Work items

1. Kotlin `AttachmentOpener.kt` + MainActivity registration (~60 lines).
2. Rust `open_attachment` command + invocation table entry (~50 lines,
   cfg android; JNI in the open_in_app_browser style).
3. `_openFile` Android branch: route non-media to the command (~10 lines).
4. Cache `opens/` cleanup on boot (~10 lines, Kotlin side).
5. Optional hardening: cap copy size (e.g. refuse > 200 MB with a toast).

### Test procedure (device, phone 10ADBJ0KSF001Q7)

- pdf/doc/xlsx from a second account into the test chat; tap open →
  the system picker offers a PDF viewer; the document renders; edits made by
  the viewer (if any) must NOT round-trip (one-way view is fine and expected).
- A file with no handling app installed (e.g. .opus-less device or .xyz) →
  "No app can open this file" toast, no crash.
- Media files keep opening in the lightbox (ae061db behavior preserved).
- Animated webp regression check: still lightbox, no opener involvement.
- Notification tap / deep link / relay flows unaffected by the manifest
  (Option A touches no manifest lines).

### Acceptance

- No OpenArgs-style plugin errors from any open path on Android.
- Non-media attachments open read-only in an external app when one exists.
- Nothing outside `cacheDir/opens/` is ever granted to another app.
- Desktop/PWA: no behavior change.

### Out of scope / follow-ups

- Editing round-trips (viewer saving back into the chat) — not planned.
- The thumbnail pipeline is unrelated to this plan and already shipped
  (16f4ea9): bubble images request ?w=720 downscaled JPEGs from both the
  blobfile protocol and the loopback media server, cache under
  `<app-data>/thumbs`, animated gif/webp and lightbox requests keep originals.
