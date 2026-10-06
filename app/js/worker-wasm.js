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
async function restore() {
  const root = await opfsRoot();
  if (!root) return;
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
// renames between checkpoints propagate on the next restore.
async function checkpoint() {
  const root = await opfsRoot();
  if (!root || !glue) return;
  try { await root.removeEntry("accounts", { recursive: true }); } catch {}
  const walk = async (path) => {
    for (const entry of await glue.vfs_list(path)) {
      if (entry.endsWith("/")) {
        await walk(entry);
      } else {
        const parts = entry.split("/").filter(Boolean);
        let dir = root;
        for (let i = 0; i < parts.length - 1; i++) {
          dir = await dir.getDirectoryHandle(parts[i], { create: true });
        }
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const w = await fh.createWritable();
        await w.write(glue.vfs_read(entry));
        await w.close();
      }
    }
  };
  await walk("/accounts");
}

self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === "boot") {
    try {
      glue = await import(d.glueUrl);
      await glue.default();
      const persist = d.persist !== false;
      if (persist) await restore();
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
