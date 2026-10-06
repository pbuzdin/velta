// C2: wasm core in a dedicated worker. Bridges postMessage ↔ the wrapper's
// message-oriented JSON-RPC (init / receive / on_message). Accounts live in
// memfs for now (ephemeral); OPFS persistence + Web Locks single-tab gate
// land with C4.
let dc = null;

self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === "boot") {
    try {
      const glue = await import(d.glueUrl);
      await glue.default();
      dc = await glue.init(
        (line) => self.postMessage({ type: "line", line }),
        d.wsProxyUrl ?? null,
        false,
      );
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "boot-error", error: String(err?.message ?? err) });
    }
  } else if (d.type === "line" && dc) {
    dc.receive(d.line);
  }
};
