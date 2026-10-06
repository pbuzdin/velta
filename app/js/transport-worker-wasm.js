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
  }

  async setReceiver(fn) {
    this._receiver = fn;
    if (!this._worker) await this._boot();
  }

  send(line) {
    this._worker?.postMessage({ type: "line", line });
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
