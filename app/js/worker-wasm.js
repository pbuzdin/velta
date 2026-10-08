// C2: wasm core in a dedicated worker. Bridges postMessage ↔ the wrapper's
// message-oriented JSON-RPC (init / receive / on_message). Persistence:
// OPFS mirror of the memfs /accounts tree — restored before core init,
// checkpointed on demand and on an interval (full rewrite, so deletions
// propagate). Single-tab exclusivity is enforced by the transport via
// navigator.locks (two writers would corrupt the snapshot).
let dc = null;
let glue = null;

async function opfsRoot() {
  try {
    return navigator.storage?.getDirectory ? await navigator.storage.getDirectory() : null;
  } catch {
    return null;
  }
}

// OPFS snapshot → memfs, before core init (restore survives even a core that
// never gets to boot — it only needs the module-level vfs_* bindings).
async function restore(root) {
  const walk = async (dir, prefix) => {
    for await (const [name, handle] of dir.entries()) {
      const p = `${prefix}/${name}`;
      if (handle.kind === "directory") {
        await walk(handle, p);
      } else {
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        glue.vfs_mkdirp(p.slice(0, p.lastIndexOf("/")) || "/");
        glue.vfs_write(p, bytes);
      }
    }
  };
  await walk(root, "");
}

// memfs /accounts → OPFS. Full rewrite of the snapshot so deletions and
// renames between checkpoints propagate on the next restore. The snapshot is
// staged in memory first: removeEntry must not run unless the memfs walk
// fully succeeded, or a mid-walk throw would leave OPFS wiped (#106).
async function checkpoint() {
  const root = await opfsRoot();
  if (!root || !glue) return;
  const files = [];
  const walk = async (path) => {
    for (const entry of await glue.vfs_list(path)) {
      if (entry.endsWith("/")) {
        await walk(entry);
      } else {
        files.push({ path: entry, bytes: glue.vfs_read(entry) });
      }
    }
  };
  await walk("/accounts");
  try { await root.removeEntry("accounts", { recursive: true }); } catch {}
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: true });
    }
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(f.bytes);
    await w.close();
  }
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
  } else if (d.type === "checkpoint") {
    checkpoint().catch(() => {});
  } else if (d.type === "read-file") {
    try {
      const bytes = glue.vfs_read(d.path);
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
