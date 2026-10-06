// C2 transport: satisfies the JsonRpcCore transport contract
// { name, send(line), setReceiver(fn) } by hosting the wasm core in a
// module worker (worker-wasm.js). Feature-detect at the boot site decides
// between this and the Tauri/WS transports (no __TAURI__ + PWA + wasm flag).
export class WorkerWasmTransport {
  constructor({
    workerUrl = new URL("./worker-wasm.js", import.meta.url).href,
    glueUrl,
    wsProxyUrl = null,
  } = {}) {
    this.name = "worker-wasm";
    this._workerUrl = workerUrl;
    this._glueUrl = glueUrl;
    this._wsProxyUrl = wsProxyUrl;
    this._receiver = null;
    this._worker = null;
    this._fileSeq = 0;
  }

  async setReceiver(fn) {
    this._receiver = fn;
    if (!this._worker) await this._boot();
  }

  send(line) {
    this._worker?.postMessage({ type: "line", line });
  }

  // Generic memfs passthrough (V2.5 identity backup: grab the self-keys tar
  // the core wrote, or place one for import). Resolves Uint8Array / undefined.
  readCoreFile(path) {
    return this._fileRequest({ type: "read-file", path }, "file");
  }

  readCoreFileList(path) {
    return this._fileRequest({ type: "list-dir", path }, "dir");
  }

  writeCoreFile(path, bytes) {
    return this._fileRequest({ type: "write-file", path, bytes }, "written");
  }

  _fileRequest(msg, okType) {
    if (!this._worker) return Promise.reject(new Error("worker not booted"));
    const id = ++this._fileSeq;
    return new Promise((resolve, reject) => {
      const onMsg = (e) => {
        const d = e.data;
        if (d.id !== id) return;
        this._worker.removeEventListener("message", onMsg);
        if (d.type === okType) resolve(d.bytes ?? d.entries);
        else reject(new Error(d.error));
      };
      this._worker.addEventListener("message", onMsg);
      this._worker.postMessage({ ...msg, id });
    });
  }

  async _boot() {
    // Single-tab gate: two live cores would race the OPFS snapshot. Hold the
    // lock for the worker's lifetime; a second tab gets a clear error.
    if (navigator.locks?.request) {
      const acquired = await new Promise((resolve) => {
        navigator.locks
          .request("velta-wasm-core", { ifAvailable: true }, (lock) => {
            resolve(!!lock);
            if (lock) {
              return new Promise((release) => {
                this._releaseLock = release;
              });
            }
          })
          .catch(() => resolve(false));
      });
      if (!acquired) throw new Error("wasm core is already open in another tab");
    }
    return new Promise((resolve, reject) => {
      const w = new Worker(this._workerUrl, { type: "module" });
      w.onmessage = (e) => {
        const d = e.data;
        if (d.type === "line") this._receiver?.(d.line);
        else if (d.type === "ready") resolve();
        else if (d.type === "boot-error") {
          this._releaseLock?.();
          reject(new Error(d.error));
        }
      };
      w.onerror = (e) => {
        this._releaseLock?.();
        reject(new Error(`worker error: ${e.message ?? "unknown"}`));
      };
      w.postMessage({ type: "boot", glueUrl: this._glueUrl, wsProxyUrl: this._wsProxyUrl });
      this._worker = w;
    });
  }
}
