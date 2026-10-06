// transport.js — picks the best available deltachat core backend:
//   1. inside the Android WebView app → direct JS bridge (window.VeltaBridge),
//      no network involved at all
//   2. inside the Tauri shell         → in-process core via Tauri IPC
//   3. background-service APK         → core via ws://127.0.0.1:20808
//   4. background-service APK, PWA
//      served from HTTPS             → core via http://127.0.0.1:20809/rpc
//      (Chrome blocks plain ws:// to loopback from secure pages, but
//      allows fetch() with Private-Network-Access headers)
//   5. anything else (dev/demo)       → mock core
import { JsonRpcCore } from "./rpc-core.js";
import { WorkerWasmTransport } from "./transport-worker-wasm.js";

const WS_URL = "ws://127.0.0.1:20808";
const HTTP_URL = "http://127.0.0.1:20809";
const WS_PROBE_MS = 900;
const HTTP_PROBE_MS = 1500;

// Architecture C (PWA): opt-in wasm core hosted in a worker. Enabled by
// ?wasm=1 (or localStorage velta-wasm=1) and only tried when no native shell
// exists — the Tauri/Android builds never take this path. The glue bundle
// location is overridable via ?wasm-glue= / localStorage velta-wasm-glue
// (defaults to ./wasm/ next to the app, i.e. the PWA dist layout from C4).
function wasmOptIn() {
  try {
    const params = new URLSearchParams(location.search);
    if (params.has("wasm")) return params.get("wasm") !== "0";
    return localStorage.getItem("velta-wasm") === "1";
  } catch { return false; }
}

function wasmGlueUrl() {
  try {
    const params = new URLSearchParams(location.search);
    const override = params.get("wasm-glue") || localStorage.getItem("velta-wasm-glue");
    if (override) return override;
  } catch {}
  return new URL("wasm/deltachat_wasm.js", document.baseURI).href;
}

function rustLog(msg) {
  try {
    console.log("[velta]", msg);
  } catch {}
  try {
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    if (invoke) {
      invoke("js_log", { msg }).catch(() => {});
    }
  } catch {}
}

/* ---------------- Android WebView JS bridge (in-app, no network) ---------------- */

function androidWebViewTransport() {
  const bridge = window.VeltaBridge;
  return {
    name: "android-webview",
    label: "in-app core (Android)",
    setReceiver(fn) { window.__veltaOnLine = fn; },
    send(line) { bridge.send(line); },
    async reconnect() { return true; }, // in-process bridge can't drop
  };
}

function tauriTransport() {
  const tauri = window.__TAURI__;
  const core = tauri.core || tauri;
  const event = tauri.event || tauri;
  const invoke = core.invoke ? core.invoke.bind(core) : tauri.invoke.bind(tauri);
  const listen = event.listen ? event.listen.bind(event) : tauri.listen.bind(tauri);
  // The command's return value is the response path (#49): the desktop rpc
  // command parks the request id and resolves with the response line. It is
  // fed to the same receiver so rpc-core keeps its single-stream design;
  // the velta-rpc broadcast then carries only core-pushed events. Captured
  // synchronously — the listener install below can take seconds (see the
  // comment there), and the handshake must not ride on it anymore.
  let receiver = null;
  return {
    name: "tauri",
    label: "embedded core (Tauri)",
    async setReceiver(fn) {
      receiver = fn;
      // Do NOT race event.listen() against a timeout. On Android the Tauri
      // event bridge subscription can legitimately take a few seconds to
      // install while the WebView finishes coming up, and treating that delay
      // as a transport failure causes the JSON-RPC handshake to be lost —
      // core.init() then sends get_all_account_ids before the receiver is
      // wired, the response is dropped, and the app falls back to demo mode.
      //
      // The createCore() global deadline (20s) still bounds the overall
      // startup so a genuinely broken bridge can't hang the UI forever.
      await listen("velta-rpc", ev => fn(ev.payload));
    },
    send(line) {
      // Return the promise so rpc-core can catch invoke errors; a resolved
      // string is the response line (desktop correlation, #49) and feeds the
      // receiver. Android's write-only arm resolves empty — its responses
      // still arrive via the broadcast.
      const result = invoke("rpc", { request: line });
      if (result && typeof result.then === "function") {
        result.then((resp) => {
          if (receiver && typeof resp === "string" && resp) receiver(resp);
        }).catch(() => {}); // rpc-core handles invoke errors itself
      }
      return result;
    },
    async reconnect() { return true; },
  };
}

// V-01/#61: loopback bridges authenticate with a per-service-start token.
// PWA pairing: run the service APK once, copy the token from its dialog,
// paste into this key (once per service restart).
function bridgeToken() {
  try { return localStorage.getItem("velta-bridge-token") || ""; } catch { return ""; }
}

function probeWebSocket() {
  return new Promise(resolve => {
    let done = false;
    const finish = ws => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ws);
    };
    let ws;
    try { ws = new WebSocket(WS_URL); } catch { return resolve(null); }
    const timer = setTimeout(() => { try { ws.close(); } catch {} finish(null); }, WS_PROBE_MS);
    // The service gates the bridge on the client's FIRST message — send the
    // token the moment the socket opens, before any RPC rides the wire.
    ws.onopen = () => {
      const token = bridgeToken();
      if (token) { try { ws.send(token); } catch {} }
      finish(ws);
    };
    ws.onerror = () => finish(null);
    ws.onclose = () => finish(null);
  });
}

function statusEvent(connected, backend) {
  dispatchEvent(new CustomEvent("velta-core-status", { detail: { connected, backend } }));
}

async function websocketTransport() {
  let ws = await probeWebSocket();
  if (!ws) return null;
  let receiver = null;
  const wire = socket => {
    socket.onmessage = ev => receiver?.(ev.data);
    socket.onclose = () => {
      if (socket !== ws) return; // stale socket from an old connection
      statusEvent(false, "websocket");
      dispatchEvent(new CustomEvent("velta-core-disconnected"));
    };
  };
  wire(ws);
  return {
    name: "websocket",
    label: "local core (service)",
    setReceiver(fn) { receiver = fn; },
    send(line) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error("websocket closed");
      ws.send(line);
    },
    // re-probe the service and swap in a fresh socket; resolves false if the
    // service is still unreachable
    async reconnect() {
      const fresh = await probeWebSocket();
      if (!fresh) return false;
      try { ws.close(); } catch {}
      ws = fresh;
      wire(ws);
      return true;
    },
  };
}

/* ---------------- HTTP bridge transport (HTTPS-hosted PWAs) ---------------- */

async function probeHttp() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_PROBE_MS);
    const res = await fetch(HTTP_URL + "/health", { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch { return false; }
}

function httpTransport() {
  let receiver = null;
  let alive = true;
  return {
    name: "http",
    label: "local core (service)",
    setReceiver(fn) { receiver = fn; },
    send(line) {
      if (!alive) throw new Error("http transport closed");
      // fire-and-forget for the caller; the response arrives via receiver
      const token = bridgeToken();
      fetch(HTTP_URL + "/rpc", {
        method: "POST",
        body: line,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
        .then(r => r.text())
        .then(text => receiver?.(text))
        .catch(() => {
          if (!alive) return;
          alive = false;
          statusEvent(false, "http");
          dispatchEvent(new CustomEvent("velta-core-disconnected"));
        });
    },
    async reconnect() {
      const ok = await probeHttp();
      if (ok) alive = true;
      return ok;
    },
  };
}

// Light-weight check used by the status pill: is a background core reachable?
export async function probeService() {
  const ws = await probeWebSocket();
  if (ws) { try { ws.close(); } catch {} return true; }
  return probeHttp();
}

export async function createCore({ onDiagnostic = () => {} } = {}) {
  const diagnostic = (level, message) => {
    rustLog(message);
    onDiagnostic(level, message);
  };
  diagnostic("info", "Core connection started");

  // Mock mode (set from the drawer menu): skip every real backend.
  if (localStorage.getItem("velta-mock") === "1") {
    diagnostic("info", "Mock mode enabled; using the demo core");
    const { MockCore } = await import("./mock-core.js");
    const mock = new MockCore();
    mock.backend = { kind: "mock", label: "demo mode (mock core)", connected: true };
    statusEvent(true, "mock");
    return mock;
  }

  const attempts = [];
  if (window.VeltaBridge) attempts.push(() => androidWebViewTransport());
  if (window.__TAURI__) {
    diagnostic("info", "Tauri runtime detected; probing embedded core");
    attempts.push(() => tauriTransport());
  }
  // Opt-in wasm core (Architecture C): first in line when explicitly enabled
  // on a non-native shell, so it wins over the loopback service probes.
  if (wasmOptIn() && !window.VeltaBridge && !window.__TAURI__) {
    diagnostic("info", "wasm opt-in: trying worker-wasm core");
    attempts.push(() => new WorkerWasmTransport({ glueUrl: wasmGlueUrl() }));
  }
  attempts.push(websocketTransport);
  attempts.push(async () => (await probeHttp()) ? httpTransport() : null);

  // Global timeout: if no backend connects within 20s, bail to mock immediately.
  // This prevents the UI from being stuck on "connecting" for 30+ seconds.
  // This deadline also bounds the tauriTransport().setReceiver() call, which
  // deliberately no longer has its own per-listener timeout (see comment there).
  const GLOBAL_TIMEOUT_MS = 20_000;
  const deadline = Date.now() + GLOBAL_TIMEOUT_MS;

  for (const make of attempts) {
    if (Date.now() >= deadline) {
      diagnostic("error", "Core connection deadline reached; skipping remaining backends");
      break;
    }
    let transport = null;
    try { transport = await make(); } catch (e) { diagnostic("warning", `Backend probe failed: ${e}`); }
    if (!transport) continue;
    diagnostic("info", `Trying ${transport.label || transport.name}`);
    const initAttempts = transport.name === "android-webview" ? 5 : transport.name === "tauri" ? 3 : 1;
    for (let i = 1; i <= initAttempts; i++) {
      if (Date.now() >= deadline) {
        diagnostic("error", `Connection deadline reached during ${transport.name} attempt ${i}`);
        break;
      }
      try {
        const core = new JsonRpcCore(transport);
        diagnostic("info", `Initializing ${transport.name} (attempt ${i}/${initAttempts})`);
        await core.init();
        core.backend = { kind: transport.name, label: transport.label || transport.name, connected: true };
        console.info("[velta] using backend:", transport.name);
        statusEvent(true, transport.name);
        diagnostic("info", `Connected to ${transport.label || transport.name}`);
        return core;
      } catch (e) {
        diagnostic("error", `${transport.name} initialization failed: ${e?.message || e}`);
        console.warn(`[velta] backend init failed (${transport.name}, attempt ${i}/${initAttempts}):`, e);
        if (i === initAttempts) {
          statusEvent(false, transport.name);
          dispatchEvent(new CustomEvent("velta-core-init-failed", { detail: { backend: transport.name } }));
        } else {
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }
  }
  diagnostic("warning", "No real core responded; entering demo mode");
  console.info("[velta] falling back to mock core");
  const { MockCore } = await import("./mock-core.js");
  const mock = new MockCore();
  mock.backend = { kind: "mock", label: "demo mode (no local core)", connected: false };
  return mock;
}