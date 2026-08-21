// transport.js — picks the best available deltachat core backend:
//   1. inside the Android WebView app → direct JS bridge (window.DcBridge),
//      no network involved at all
//   2. inside the Tauri shell         → in-process core via Tauri IPC
//   3. background-service APK         → core via ws://127.0.0.1:20808
//   4. background-service APK, PWA
//      served from HTTPS             → core via http://127.0.0.1:20809/rpc
//      (Chrome blocks plain ws:// to loopback from secure pages, but
//      allows fetch() with Private-Network-Access headers)
//   5. anything else (dev/demo)       → mock core
import { MockCore } from "./mock-core.js";
import { JsonRpcCore } from "./rpc-core.js";

const WS_URL = "ws://127.0.0.1:20808";
const HTTP_URL = "http://127.0.0.1:20809";
const WS_PROBE_MS = 900;
const HTTP_PROBE_MS = 1500;

function rustLog(msg) {
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
  const bridge = window.DcBridge;
  return {
    name: "android-webview",
    label: "in-app core (Android)",
    setReceiver(fn) { window.__dcOnLine = fn; },
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
  return {
    name: "tauri",
    label: "embedded core (Tauri)",
    async setReceiver(fn) {
      await Promise.race([
        event.listen("dc-rpc", ev => fn(ev.payload)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("tauri event listen timeout")), 5000))
      ]);
    },
    send(line) {
      // Return the promise so rpc-core can catch invoke errors
      return invoke("rpc", { request: line });
    },
  };
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
    ws.onopen = () => finish(ws);
    ws.onerror = () => finish(null);
    ws.onclose = () => finish(null);
  });
}

function statusEvent(connected, backend) {
  dispatchEvent(new CustomEvent("dc-core-status", { detail: { connected, backend } }));
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
      dispatchEvent(new CustomEvent("dc-core-disconnected"));
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
      fetch(HTTP_URL + "/rpc", { method: "POST", body: line })
        .then(r => r.text())
        .then(text => receiver?.(text))
        .catch(() => {
          if (!alive) return;
          alive = false;
          statusEvent(false, "http");
          dispatchEvent(new CustomEvent("dc-core-disconnected"));
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

export async function createCore() {
  rustLog("createCore started");
  const attempts = [];
  if (window.DcBridge) attempts.push(() => androidWebViewTransport());
  if (window.__TAURI__) {
    rustLog("tauri global detected");
    attempts.push(() => tauriTransport());
  }
  attempts.push(websocketTransport);
  attempts.push(async () => (await probeHttp()) ? httpTransport() : null);

  // Global timeout: if no backend connects within 20s, bail to mock immediately.
  // This prevents the UI from being stuck on "connecting" for 30+ seconds.
  const GLOBAL_TIMEOUT_MS = 20_000;
  const deadline = Date.now() + GLOBAL_TIMEOUT_MS;

  for (const make of attempts) {
    if (Date.now() > deadline) {
      rustLog("global timeout reached, skipping remaining backends");
      break;
    }
    let transport = null;
    try { transport = await make(); } catch (e) { rustLog(`probe failed: ${e}`); }
    if (!transport) continue;
    rustLog(`trying backend ${transport.name}`);
    const initAttempts = transport.name === "android-webview" ? 5 : transport.name === "tauri" ? 3 : 1;
    for (let i = 1; i <= initAttempts; i++) {
      if (Date.now() > deadline) {
        rustLog(`global timeout reached during ${transport.name} attempt ${i}`);
        break;
      }
      rustLog("global timeout reached, skipping remaining backends");
      break;
    }
    let transport = null;
    try { transport = await make(); } catch (e) { rustLog(`probe failed: ${e}`); }
    if (!transport) continue;
    rustLog(`trying backend ${transport.name}`);
    const initAttempts = transport.name === "android-webview" ? 5 : transport.name === "tauri" ? 3 : 1;
    for (let i = 1; i <= initAttempts; i++) {
      if (Date.now() > deadline) {
        rustLog(`global timeout reached during ${transport.name} attempt ${i}`);
        break;
      }
      try {
        const core = new JsonRpcCore(transport);
        rustLog(`init ${transport.name} attempt ${i}`);
        await core.init();
        core.backend = { kind: transport.name, label: transport.label || transport.name, connected: true };
        console.info("[delta-web] using backend:", transport.name);
        statusEvent(true, transport.name);
        return core;
      } catch (e) {
        rustLog(`init failed ${transport.name}: ${e}`);
        console.warn(`[delta-web] backend init failed (${transport.name}, attempt ${i}/${initAttempts}):`, e);
        if (i === initAttempts) {
          statusEvent(false, transport.name);
          dispatchEvent(new CustomEvent("dc-core-init-failed", { detail: { backend: transport.name } }));
        } else {
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }
  }
  rustLog("falling back to mock core");
  console.info("[delta-web] falling back to mock core");
  const mock = new MockCore();
  mock.backend = { kind: "mock", label: "demo mode (no local core)", connected: false };
  return mock;
}
