// PWA websocket relays. The wasm core has one tunnel base, set once at boot
// (wss://<domain>, C3 websockify on that relay). The baked
// window.VELTA_PWA.wsProxyUrl stays the default until a domain is chosen here.
const LIST_KEY = "velta-ws-relays";
const ACTIVE_KEY = "velta-ws-relay";

export function normalizeHost(raw) {
  let s = String(raw || "").trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) ? s : null;
}

function bakedProxyUrl() {
  const url = window.VELTA_PWA?.wsProxyUrl;
  return typeof url === "string" ? url.replace(/\/+$/, "") : "";
}

function bakedHost() {
  const url = bakedProxyUrl();
  if (!url) return "";
  try { return normalizeHost(new URL(url).hostname) || ""; }
  catch { return normalizeHost(url) || ""; }
}

function storedList() {
  try {
    const list = JSON.parse(localStorage.getItem(LIST_KEY) || "null");
    if (!Array.isArray(list)) return null;
    const hosts = [];
    for (const item of list) {
      const host = normalizeHost(item);
      if (host && !hosts.includes(host)) hosts.push(host);
    }
    return hosts;
  } catch {
    return null;
  }
}

export function listWsRelays() {
  const stored = storedList();
  if (stored && stored.length) return stored;
  const baked = bakedHost();
  return baked ? [baked] : [];
}

export function activeWsRelay() {
  const list = listWsRelays();
  const stored = localStorage.getItem(ACTIVE_KEY);
  if (stored && list.includes(stored)) return stored;
  return list[0] || "";
}

// Untouched installs keep the baked URL, including a non-wss dev proxy.
export function wsProxyUrl() {
  const stored = storedList();
  const active = localStorage.getItem(ACTIVE_KEY);
  if (stored && active && stored.includes(active)) return `wss://${active}`;
  const baked = bakedProxyUrl();
  if (baked) return baked;
  return stored?.[0] ? `wss://${stored[0]}` : null;
}

function write(list, active) {
  localStorage.setItem(LIST_KEY, JSON.stringify(list));
  if (active) localStorage.setItem(ACTIVE_KEY, active);
}

export function addWsRelay(raw) {
  const host = normalizeHost(raw);
  if (!host) return null;
  const list = listWsRelays();
  if (!list.includes(host)) write([...list, host], activeWsRelay());
  return host;
}

export function editWsRelay(from, raw) {
  const next = normalizeHost(raw);
  const list = listWsRelays();
  if (!next || !list.includes(from)) return null;
  if (next !== from && list.includes(next)) return null;
  const active = activeWsRelay() === from ? next : activeWsRelay();
  write(list.map((h) => (h === from ? next : h)), active);
  return next;
}

export function removeWsRelay(host) {
  const list = listWsRelays();
  if (!list.includes(host) || list.length < 2) return false;
  const next = list.filter((h) => h !== host);
  write(next, activeWsRelay() === host ? next[0] : activeWsRelay());
  return true;
}

export function useWsRelay(host) {
  const list = listWsRelays();
  if (!list.includes(host)) return false;
  write(list, host);
  return true;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export async function showWsRelaysModal() {
  const { showModal, toast } = await import("./ui.js");
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="font-size:14.5px;line-height:1.5;margin-bottom:8px">Mail in this browser tunnels through the relay marked in use. Switching reloads the page.</p>
    <div class="modal-list" data-relay-list style="max-height:220px;overflow:auto"></div>
    <form data-relay-form style="display:flex;gap:8px;margin:10px 0 0">
      <input class="text-field" data-relay-input required placeholder="relay.example.org" autocomplete="off" inputmode="url" autocapitalize="none" spellcheck="false" style="flex:1">
      <button type="submit" class="btn-text" data-relay-save>Add</button>
    </form>`;
  const listEl = body.querySelector("[data-relay-list]");
  const input = body.querySelector("[data-relay-input]");
  const saveBtn = body.querySelector("[data-relay-save]");
  let editing = null;

  const changed = (before, fn) => {
    const result = fn();
    if (result && wsProxyUrl() !== before) {
      toast("Relay changed — reloading");
      setTimeout(() => location.reload(), 400);
    }
    return result;
  };

  const render = () => {
    listEl.replaceChildren();
    const active = activeWsRelay();
    for (const host of listWsRelays()) {
      const item = document.createElement("div");
      item.className = "info-row";
      item.innerHTML = `<span class="v">${esc(host)}${host === active ? ' <span style="opacity:.55">(in use)</span>' : ""}</span>`;
      const btn = (label, click) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn-text";
        b.textContent = label;
        b.addEventListener("click", click);
        item.appendChild(b);
      };
      if (host !== active) btn("Use", () => changed(wsProxyUrl(), () => useWsRelay(host)));
      btn("Edit", () => {
        editing = host;
        input.value = host;
        saveBtn.textContent = "Save";
        input.focus();
      });
      if (listWsRelays().length > 1) {
        btn("Remove", () => {
          changed(wsProxyUrl(), () => removeWsRelay(host));
          if (editing === host) { editing = null; saveBtn.textContent = "Add"; input.value = ""; }
          render();
        });
      }
      listEl.appendChild(item);
    }
  };
  render();
  showModal({ title: "WebSocket relays", body });
  body.querySelector("[data-relay-form]").addEventListener("submit", (e) => {
    e.preventDefault();
    const before = wsProxyUrl();
    if (editing) {
      const from = editing;
      const next = editWsRelay(from, input.value);
      editing = null;
      saveBtn.textContent = "Add";
      if (!next) { toast("Enter a different domain, e.g. relay.example.org"); return; }
      input.value = "";
      if (wsProxyUrl() !== before) {
        toast("Relay changed — reloading");
        setTimeout(() => location.reload(), 400);
        return;
      }
      render();
      return;
    }
    const host = addWsRelay(input.value);
    if (!host) { toast("Enter a domain, e.g. relay.example.org"); return; }
    input.value = "";
    render();
    toast(`${host} added`);
  });
}
