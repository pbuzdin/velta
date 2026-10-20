// C2: wasm core in a dedicated worker. Bridges postMessage ↔ the wrapper's
// message-oriented JSON-RPC (init / receive / on_message). Persistence:
// OPFS mirror of the memfs /accounts tree — restored before core init,
// checkpointed on demand and on an interval (full rewrite, so deletions
// propagate). Single-tab exclusivity is enforced by the transport via
// navigator.locks (two writers would corrupt the snapshot).
let dc = null;
let glue = null;

// Stock chatmail POST /new has no CORS header, so the browser cannot read
// the minted address. /cm-new/<host> on this origin is the relay proxy.
// ponytail: pathname /new only; a /new_email QR still goes direct.
function chatmailNewUrl(input, init, page) {
  try {
    const raw = typeof input === "string" ? input : input?.url;
    if (!raw || !page?.origin) return null;
    const url = new URL(raw, page.href);
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    if (method !== "POST" || url.pathname !== "/new" || url.port || url.hostname === page.hostname) return null;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(url.hostname)) return null;
    return new URL("/cm-new/" + url.hostname + url.search, page.origin).href;
  } catch {
    return null;
  }
}

const _fetch = typeof self.fetch === "function" ? self.fetch.bind(self) : null;
if (_fetch) {
  self.fetch = (input, init) => {
    const proxied = chatmailNewUrl(input, init, self.location);
    if (!proxied) return _fetch(input, init);
    return _fetch(proxied, { method: "POST", redirect: init?.redirect, signal: init?.signal });
  };
}

async function opfsRoot() {
  try {
    return navigator.storage?.getDirectory ? await navigator.storage.getDirectory() : null;
  } catch {
    return null;
  }
}

// OPFS layout (#123/#126):
//   snap-<n>/accounts/...   memfs tree (accounts.toml, blob dirs)
//   snap-<n>/sqlite/<enc>   in-memory SQLite databases (dc.db lives there,
//                           NOT in the memfs — see the wrapper's sqlite_*)
//   current                 text "<n>" — written last, so a snapshot only
//                           counts once it is complete
// Older builds kept a single accounts/ tree that every checkpoint deleted
// and rewrote; a reload during that window booted an empty profile, and the
// databases were never saved at all. Legacy accounts/ is still restored when
// no `current` exists.
const encName = (n) => encodeURIComponent(n);
const decName = (n) => decodeURIComponent(n);

async function readText(dir, name) {
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch { return null; }
}

async function writeFile(dir, name, bytes) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
}

async function restoreTree(dir, prefix) {
  for await (const [name, handle] of dir.entries()) {
    const p = `${prefix}/${name}`;
    if (handle.kind === "directory") {
      await restoreTree(handle, p);
    } else {
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      glue.vfs_mkdirp(p.slice(0, p.lastIndexOf("/")) || "/");
      glue.vfs_write(p, bytes);
    }
  }
}

let generation = 0;

// OPFS snapshot → memfs + sqlite, before core init.
async function restore(root) {
  const cur = Number.parseInt(await readText(root, "current") || "", 10);
  if (Number.isFinite(cur) && cur > 0) {
    const snap = await root.getDirectoryHandle(`snap-${cur}`);
    generation = cur;
    try { await restoreTree(await snap.getDirectoryHandle("accounts"), "/accounts"); } catch (e) { if (e?.name !== "NotFoundError") throw e; }
    let dbs = null;
    try { dbs = await snap.getDirectoryHandle("sqlite"); } catch {}
    if (dbs) {
      if (typeof glue.sqlite_import !== "function") throw new Error("this wasm core cannot restore databases");
      for await (const [name, handle] of dbs.entries()) {
        if (handle.kind !== "file") continue;
        glue.sqlite_import(decName(name), new Uint8Array(await (await handle.getFile()).arrayBuffer()));
      }
    }
    return;
  }
  let legacy = null;
  try { legacy = await root.getDirectoryHandle("accounts"); } catch {}
  if (legacy) await restoreTree(legacy, "/accounts");
}

// One snapshot at a time. A refresh flush and the interval must not both
// write a generation.
let checkpointChain = Promise.resolve();
function checkpoint() {
  const run = checkpointChain.then(snapshot, snapshot);
  checkpointChain = run.then(() => {}, () => {});
  return run;
}

let lastDigest = "";

// Collect memfs + databases, then write them into a NEW generation directory
// and flip `current`. The previous generation stays intact until the flip, so
// a reload or a killed worker at any point leaves a complete snapshot behind.
async function snapshot() {
  const root = await opfsRoot();
  if (!root || !glue) return;
  // Databases FIRST, then the memfs. vfs_list is async, so the core runs
  // between the awaits of the walk. The core writes a blob before the row
  // that names it (set_config selfavatar, send_msg, received attachments),
  // so a db captured before the walk only names blobs the walk will find.
  // The old order (walk, then dbs) could save `selfavatar` = a blob that
  // was written after its directory was listed: after a reload the avatar
  // pointed at a missing file and outgoing mail had no Chat-User-Avatar.
  const dbs = [];
  if (typeof glue.sqlite_list === "function") {
    // Synchronous on purpose: no await between exports, so the databases
    // are captured at one point of the core's timeline.
    for (const name of glue.sqlite_list()) dbs.push({ name, bytes: glue.sqlite_export(name) });
  }
  const files = [];
  const walk = async (path) => {
    for (const entry of await glue.vfs_list(path)) {
      if (entry.endsWith("/")) await walk(entry);
      else {
        // Deleted between list and read (housekeeping): skip, not fail.
        let bytes;
        try { bytes = glue.vfs_read(entry); } catch { continue; }
        files.push({ path: entry, bytes });
      }
    }
  };
  await walk("/accounts");
  const digest = await digestOf(files, dbs);
  if (digest === lastDigest) return;
  const next = generation + 1;
  // A worker killed mid-write can leave a partial snap-<next>; start clean.
  try { await root.removeEntry(`snap-${next}`, { recursive: true }); } catch {}
  const snap = await root.getDirectoryHandle(`snap-${next}`, { create: true });
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let dir = snap;
    for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create: true });
    await writeFile(dir, parts[parts.length - 1], f.bytes);
  }
  if (dbs.length) {
    const dir = await snap.getDirectoryHandle("sqlite", { create: true });
    for (const d of dbs) await writeFile(dir, encName(d.name), d.bytes);
  }
  await writeFile(root, "current", new TextEncoder().encode(String(next)));
  generation = next;
  lastDigest = digest;
  // Old generations (and the legacy tree) only go after the flip.
  for await (const [name] of root.entries()) {
    if (name === `snap-${next}` || name === "current") continue;
    if (name === "accounts" || /^snap-\d+$/.test(name)) {
      try { await root.removeEntry(name, { recursive: true }); } catch {}
    }
  }
}

async function digestOf(files, dbs) {
  const parts = [];
  for (const f of files) parts.push(new TextEncoder().encode(f.path + "\0"), f.bytes);
  for (const d of dbs) parts.push(new TextEncoder().encode("db:" + d.name + "\0"), d.bytes);
  const buf = await new Blob(parts).arrayBuffer();
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === "boot") {
    try {
      glue = await import(d.glueUrl);
      await glue.default();
      const persist = d.persist !== false;
      if (persist) {
        // C4: ask for eviction exemption (best-effort — denial is not fatal;
        // the V2.5 identity backup is the real hedge against storage pressure).
        navigator.storage?.persist?.().catch(() => {});
        // #106: a skipped restore boots an empty core that init() reads as a
        // fresh install — it would add_account and the next checkpoint would
        // rewrite the good snapshot over it. Fail the boot loudly instead;
        // the worker answers no RPC until the snapshot is confirmed restored.
        const root = await opfsRoot();
        if (!root) throw new Error("OPFS unavailable — cannot restore accounts");
        await restore(root);
      }
      dc = await glue.init(
        (line) => self.postMessage({ type: "line", line }),
        d.wsProxyUrl ?? null,
        persist,
      );
      if (persist) setInterval(() => { checkpoint().catch(() => {}); }, 8_000);
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "boot-error", error: String(err?.message ?? err) });
    }
  } else if (d.type === "line" && dc) {
    dc.receive(d.line);
  } else if (d.type === "set-push-token") {
    // Web Push (docs/agents/web-push.md): the token is shared by every
    // account; a wasm built before the binding answers a clear error.
    try {
      if (!dc || typeof dc.set_push_device_token !== "function") throw new Error("wasm core has no set_push_device_token (rebuild velta-wasm)");
      await dc.set_push_device_token(String(d.token || ""));
      self.postMessage({ type: "push-token-set", id: d.id });
    } catch (err) {
      self.postMessage({ type: "push-token-error", id: d.id, error: String(err?.message ?? err) });
    }
  } else if (d.type === "checkpoint") {
    // Reply only after the rewrite finishes. A caller that does not wait
    // can reload during removeEntry and boot an empty account.
    checkpoint().then(
      () => self.postMessage({ type: "checkpoint-done", id: d.id }),
      (err) => self.postMessage({ type: "checkpoint-error", id: d.id, error: String(err?.message ?? err) }),
    );
  } else if (d.type === "read-file") {
    try {
      let bytes;
      try {
        bytes = glue.vfs_read(d.path);
      } catch (err) {
        // dc.db is in the SQLite VFS, not the memfs (#124's fallback read).
        if (typeof glue.sqlite_export !== "function") throw err;
        bytes = glue.sqlite_export(d.path);
      }
      self.postMessage({ type: "file", id: d.id, bytes });
    } catch (err) {
      self.postMessage({ type: "file-error", id: d.id, error: String(err?.message ?? err) });
    }
  } else if (d.type === "list-dir") {
    try {
      const entries = await glue.vfs_list(d.path);
      self.postMessage({ type: "dir", id: d.id, entries });
    } catch (err) {
      self.postMessage({ type: "file-error", id: d.id, error: String(err?.message ?? err) });
    }
  } else if (d.type === "remove-file") {
    // Temp copies the core no longer needs (/uploads/ after set_config
    // selfavatar / send_msg copied them into the blobdir). Only /uploads/:
    // the page must never delete account files.
    try {
      if (!/^\/uploads\/[^/]+$/.test(d.path || "") || d.path.includes("..")) throw new Error("only /uploads/<name> can be removed");
      try { glue.vfs_remove(d.path); } catch { /* already gone */ }
      self.postMessage({ type: "removed", id: d.id });
    } catch (err) {
      self.postMessage({ type: "file-error", id: d.id, error: String(err?.message ?? err) });
    }
  } else if (d.type === "write-file") {
    try {
      const parts = d.path.split("/").filter(Boolean);
      let dir = "/";
      for (let i = 0; i < parts.length - 1; i++) {
        dir += parts[i] + "/";
        glue.vfs_mkdirp(dir);
      }
      glue.vfs_write(d.path, d.bytes);
      self.postMessage({ type: "written", id: d.id });
    } catch (err) {
      self.postMessage({ type: "file-error", id: d.id, error: String(err?.message ?? err) });
    }
  }
};
