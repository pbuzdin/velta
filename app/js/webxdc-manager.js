// webxdc-manager.js — opens webxdc apps in a sandboxed iframe and relays
// the webxdc API between the iframe (via postMessage) and the core
// (status updates, app info). The iframe is served by the webxdc://
// protocol handler in the Rust layer, which also injects the shim that
// defines window.webxdc inside the app.

let core = null;
let active = null; // { msgId, iframe, serial }
const serials = new Map(); // msgId -> last delivered serial
const infoCache = new Map(); // msgId -> info object

// The iframe origin depends on the platform: Windows and Android serve
// custom protocols at http://<scheme>.localhost, mac/linux at <scheme>://.
function baseFor(accountId) {
  const ua = navigator.userAgent || "";
  if (/Windows|Android/.test(ua)) return `http://webxdc.localhost/${accountId}`;
  return `webxdc://localhost/${accountId}`;
}

export function initWebxdc(coreInstance) {
  core = coreInstance;
  core.addEventListener("webxdc-status-update", (e) => {
    const d = e?.detail || {};
    handleStatusUpdate(Number(d.msgId), Number(d.serial) || 0);
  });
  core.addEventListener("webxdc-instance-deleted", (e) => {
    const d = e?.detail || {};
    if (active && active.msgId === Number(d.msgId)) closeWebxdc();
    serials.delete(Number(d.msgId));
  });
  core.addEventListener("account-changing", () => {
    closeWebxdc();
    serials.clear();
  });
}

async function handleStatusUpdate(msgId, serial) {
  if (!active || active.msgId !== msgId) {
    // No app open: remember that updates exist so a later open starts fresh.
    serials.set(msgId, Math.max(serials.get(msgId) || 0, 0));
    return;
  }
  const last = active.serial || 0;
  if (serial <= last) return; // already delivered
  const { updates, serial: maxSerial } = await fetchUpdates(msgId, last);
  if (!active || active.msgId !== msgId) return;
  active.serial = maxSerial;
  serials.set(msgId, maxSerial);
  post({ type: "velta-webxdc-status-updates", updates, serial: maxSerial, done: true });
}

async function fetchUpdates(msgId, since) {
  const raw = await core.getWebxdcStatusUpdates(msgId, since);
  let updates = [];
  try { updates = JSON.parse(raw) || []; } catch { updates = []; }
  let maxSerial = since;
  for (const u of updates) maxSerial = Math.max(maxSerial, u.serial || 0);
  return { updates, serial: maxSerial };
}

function post(payload) {
  try { active?.iframe?.contentWindow?.postMessage(payload, "*"); } catch {}
}

async function handleCall(data) {
  const msgId = active?.msgId;
  switch (data.method) {
    case "getInfo": {
      const info = await getInfo(msgId);
      return { name: info.name, document: info.document || "", summary: info.summary || "",
        sourceCodeUrl: info.sourceCodeUrl || "", selfAddr: info.selfAddr || "",
        selfName: info.selfName || "", sendUpdateInterval: info.sendUpdateInterval ?? 1000,
        sendUpdateMaxSize: info.sendUpdateMaxSize ?? 0 };
    }
    case "getAllUpdates": {
      const { updates } = await fetchUpdates(msgId, 0);
      return { updates };
    }
    case "getStatusUpdates": {
      const since = Number(data.params?.serial) || 0;
      const { updates, serial } = await fetchUpdates(msgId, since);
      active.serial = Math.max(active.serial || 0, serial);
      serials.set(msgId, serial);
      return { updates, serial };
    }
    case "sendUpdate": {
      const update = data.params?.update;
      if (typeof update !== "object" || update === null) throw new Error("update must be an object");
      await core.sendWebxdcStatusUpdate(msgId, JSON.stringify(update), data.params?.description || null);
      return {};
    }
    case "sendToChat":
      return { ok: false, error: "sendToChat is not supported yet" };
    default:
      throw new Error(`unknown webxdc method: ${data.method}`);
  }
}

async function getInfo(msgId) {
  if (!infoCache.has(msgId)) {
    let info = { name: "Webxdc app", icon: "", summary: "", sourceCodeUrl: "",
      internetAccess: false, selfAddr: "", selfName: "",
      sendUpdateInterval: 1000, sendUpdateMaxSize: 0 };
    try {
      const fetched = await core.getWebxdcInfo(msgId);
      if (fetched) info = { ...info, ...fetched };
    } catch {}
    infoCache.set(msgId, info);
  }
  return infoCache.get(msgId);
}

export function infoFor(msgId) {
  return infoCache.get(msgId) || null;
}

export async function prefetchInfo(msgId) {
  await getInfo(Number(msgId));
  return infoCache.get(Number(msgId)) || null;
}

export function appIconUrl(msgId, icon) {
  const base = baseFor(core.accountId);
  return `${base}/${msgId}/${icon || "icon.png"}`;
}

export function isWebxdcOpen(msgId) {
  return active?.msgId === Number(msgId);
}

export function openWebxdc(msgId, fallbackName = "Webxdc app") {
  if (typeof document === "undefined") return;
  if (active) closeWebxdc();
  const account = core.accountId;
  const base = baseFor(account);
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-downloads allow-forms allow-modals");
  iframe.setAttribute("allow", "autoplay");
  iframe.src = `${base}/${msgId}/index.html`;
  iframe.className = "webxdc-frame";

  const wrap = document.createElement("div");
  wrap.id = "webxdc-overlay";
  wrap.innerHTML = `
    <div class="webxdc-bar">
      <div class="webxdc-title"></div>
      <button type="button" class="webxdc-close icon-btn" title="Close app" aria-label="Close app">✕</button>
    </div>`;
  wrap.appendChild(iframe);
  document.body.appendChild(wrap);

  const title = wrap.querySelector(".webxdc-title");
  const info = infoCache.get(msgId);
  title.textContent = info?.name || fallbackName || "Webxdc app";

  active = { msgId: Number(msgId), iframe, serial: serials.get(Number(msgId)) || 0 };
  wrap.querySelector(".webxdc-close").addEventListener("click", () => closeWebxdc());

  window.addEventListener("message", onWindowMessage);
}

function onWindowMessage(e) {
  if (!active) return;
  if (e.source !== active.iframe?.contentWindow) return;
  const d = e.data || {};
  if (d.type !== "velta-webxdc-call") return;
  handleCall(d)
    .then((result) => post({ type: "velta-webxdc-response", id: d.id, result }))
    .catch((error) => post({ type: "velta-webxdc-response", id: d.id, error: String(error?.message || error) }));
}

export function closeWebxdc() {
  if (!active) return;
  document.getElementById("webxdc-overlay")?.remove();
  window.removeEventListener("message", onWindowMessage);
  active = null;
}
