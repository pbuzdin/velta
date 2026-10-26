// WebSocket transport (Android and Windows apps): UI side of
// velta-app/src-tauri/src/ws_transport.rs. The shell runs a local SOCKS5
// port that carries mail through a Velta WebSocket proxy
// (tools/deploy-ws-proxy.sh, the same proxy the PWA uses natively), and
// points every profile's proxy at it — like the DNS tunnel (tunnel.js).
// Only one of the two is in use at a time.
//
// Shell commands: ws_transport_status, ws_transport_add,
// ws_transport_select, ws_transport_delete, ws_transport_test.
// Share link: velta://ws?u=<wss url>&n=<label>&t=<invite token> (confirmed
// before use). The token (from `deploy-ws-proxy.sh invite`) is what the proxy
// checks at the handshake; it travels as the subprotocol "tok.<token>".
import { escapeHtml } from "./format.js";
import { tauriInvoke } from "./tauri.js";
import { t } from "./i18n.js";
import { ICON } from "./icons.js";
import { addWsRelay, normalizeHost, setWsRelayToken, useWsRelay } from "./ws-relays.js";

export const WS_URL_MAX = 512;
export const WS_LABEL_MAX = 64;
export const WS_LINK_MAX = 2048;
export const WS_TOKEN_MAX = 1024;

/** Mirrors ws_transport.rs valid_token: b64url payload "." b64url HMAC-SHA256. */
export function validWsToken(tok) {
  return typeof tok === "string" && tok.length <= WS_TOKEN_MAX && /^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{43}$/.test(tok);
}

/** The proxy refused the invite (HTTP 401 at the handshake). */
export function isInviteRefusal(e) {
  return /\b401\b|invite (refused|invalid|expired|revoked|bad signature|malformed)/i.test(String(e?.message || e || ""));
}

function errMsg(e) {
  if (isInviteRefusal(e)) return t("the proxy refused the invite. It is invalid, expired or revoked: ask the proxy owner for a new link.");
  return String(e?.message || e || "unknown error").slice(0, 200);
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
function validHostName(h) {
  if (!h || h.length > 253 || !h.includes(".")) return false;
  return h.split(".").every(l => LABEL_RE.test(l));
}
function isIPv4(h) {
  const p = h.split(".");
  return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && +x <= 255);
}
function isLoopback(h) {
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/** Mirrors ws_transport.rs parse_proxy_url: canonical URL or throws. */
export function normalizeWsProxyUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s.length > WS_URL_MAX) throw new Error(t("Enter the proxy address"));
  if (/[\s\u0000-\u001f\u007f]/.test(s)) throw new Error(t("The address contains spaces"));
  let lower = s.toLowerCase();
  let tls = true;
  if (lower.startsWith("wss://")) lower = lower.slice(6);
  else if (lower.startsWith("ws://")) { tls = false; lower = lower.slice(5); }
  else if (lower.includes("://")) throw new Error(t("Only wss:// addresses are supported"));
  if (/[?#@\\]/.test(lower)) throw new Error(t("The address must not contain credentials, ? or #"));
  const slash = lower.indexOf("/");
  const authority = slash < 0 ? lower : lower.slice(0, slash);
  const path = slash < 0 ? "" : lower.slice(slash).replace(/\/+$/, "");
  if (path && (!/^[a-z0-9/._~-]+$/.test(path) || path.includes("//") || /\/\.\.(\/|$)/.test(path))) throw new Error(t("Bad path in the address"));
  let host, port = "";
  const m6 = authority.match(/^\[([0-9a-f:.]+)\](?::(\d*))?$/);
  if (m6) { host = m6[1]; port = m6[2] ?? ""; if (authority.endsWith(":")) port = "x"; }
  else {
    const i = authority.lastIndexOf(":");
    if (i >= 0) { host = authority.slice(0, i); port = authority.slice(i + 1) || "x"; }
    else host = authority;
  }
  host = host.replace(/\.$/, "");
  const def = tls ? 443 : 80;
  const p = port === "" ? def : (/^\d{1,5}$/.test(port) ? +port : 0);
  if (!(p > 0 && p < 65536)) throw new Error(t("Bad port"));
  if (!(m6 || isIPv4(host) || validHostName(host) || host === "localhost")) throw new Error(t("Bad host name"));
  if (!tls && !isLoopback(host)) throw new Error(t("Only wss:// addresses are supported"));
  const hostOut = m6 ? `[${host}]` : host;
  return `${tls ? "wss" : "ws"}://${hostOut}${p === def ? "" : `:${p}`}${path}`;
}

export function cleanWsLabel(l) {
  return String(l ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, WS_LABEL_MAX);
}

export function extractWsLink(rawUrl) {
  const s = String(rawUrl ?? "").trim();
  return /^velta:\/\/ws(\?|\/?$)/i.test(s) ? s : null;
}

/** Strict: only u (required), n and t, each once. Returns { url, label, token }. */
export function parseWsLink(raw) {
  const s = String(raw ?? "").trim();
  if (s.length > WS_LINK_MAX) throw new Error(t("The link is too long"));
  const m = s.match(/^velta:\/\/ws\/?\?(.*)$/i);
  if (!m) throw new Error(t("Not a WebSocket transport link"));
  const seen = new Map();
  for (const part of m[1].split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = eq < 0 ? part : part.slice(0, eq);
    if (!["u", "n", "t"].includes(k)) throw new Error(t("Unknown field in the link: {k}", { k: k.slice(0, 20) }));
    if (seen.has(k)) throw new Error(t("Repeated field in the link: {k}", { k }));
    let v;
    try { v = decodeURIComponent((eq < 0 ? "" : part.slice(eq + 1)).replace(/\+/g, " ")); }
    catch { throw new Error(t("Bad encoding in the link")); }
    seen.set(k, v);
  }
  if (!seen.has("u")) throw new Error(t("The link has no proxy address"));
  const token = seen.get("t") ?? "";
  if (seen.has("t") && !validWsToken(token)) throw new Error(t("The invite in the link is damaged"));
  return { url: normalizeWsProxyUrl(seen.get("u")), label: cleanWsLabel(seen.get("n") || ""), token };
}

export function buildWsLink({ url, label = "", token = "" }) {
  const u = normalizeWsProxyUrl(url);
  const n = cleanWsLabel(label);
  const tok = validWsToken(token) ? token : "";
  return `velta://ws?u=${encodeURIComponent(u)}${n ? `&n=${encodeURIComponent(n)}` : ""}${tok ? `&t=${tok}` : ""}`;
}

export function wsProxyHost(url) {
  try { return normalizeWsProxyUrl(url).replace(/^wss?:\/\//, "").split("/")[0]; } catch { return ""; }
}

export function wsProxyName(p) {
  return cleanWsLabel(p?.label) || wsProxyHost(p?.url) || t("unknown server");
}

/** The IMAP host the test button asks /dns/ for: configured server, else the address's domain. */
export function testHostFor({ mailServer = "", addr = "" } = {}) {
  const h = String(mailServer || "").trim().toLowerCase().replace(/\.$/, "");
  if (validHostName(h)) return h;
  const d = String(addr || "").split("@")[1]?.trim().toLowerCase() || "";
  return validHostName(d) ? d : "";
}

/** Platform note: { supported, text }. */
export function wsTransportPlatform({ tauri = false, android = false, windows = false, status = null } = {}) {
  if (!tauri) return { supported: false, text: t("The web app already sends mail over WebSocket. Pick its proxy under “WebSocket relays”.") };
  if (status?.supported || android || windows) return { supported: true, text: "" };
  return { supported: false, text: t("The WebSocket transport is available in the Android and Windows apps. On this computer, use a proxy in the profile's connection settings.") };
}

let cachedStatus = null;
export function wsTransportStatus() { return cachedStatus; }
export async function refreshWsTransportStatus(invoke = tauriInvoke()) {
  if (!invoke) return (cachedStatus = null);
  try { cachedStatus = await invoke("ws_transport_status"); } catch { cachedStatus = null; }
  return cachedStatus;
}

export function wsDrawerLabel(status) {
  if (!status?.supported) return t("Not available");
  const a = (status.proxies || []).find(p => p.id === status.active);
  return a ? wsProxyName(a) : t("Off");
}

export function wsConfirmText({ url, label, token = "" }, { current = null } = {}) {
  const lines = [];
  if (label) lines.push(t("Name: {label}", { label }));
  lines.push(t("Proxy server: {host}", { host: wsProxyHost(url) }));
  if (token) lines.push(t("The link includes an invite that lets you use this proxy. Keep it private."));
  if (current) lines.push(t("This replaces the transport in use ({name}); it stays saved.", { name: current }));
  lines.push(
    t("All chat traffic will go through this WebSocket proxy while it is in use. Your messages stay end-to-end encrypted, but the server operator sees which relays you connect to and when."),
    t("Only add proxies from someone you trust. Turning it on stops the DNS tunnel if one is in use."),
  );
  return lines.join("\n\n");
}

export function wsListHtml(status) {
  const rows = status?.proxies || [];
  if (!rows.length) return `<li class="tunnel-row"><span class="tunnel-sub">${escapeHtml(t("No saved proxies."))}</span></li>`;
  return rows.map(p => {
    const on = p.id === status.active;
    const name = wsProxyName(p);
    const host = p.label ? wsProxyHost(p.url) : "";
    const sub = p.token ? (host ? t("{host} · with invite", { host }) : t("With invite")) : host;
    const id = escapeHtml(String(p.id).replace(/[^a-z0-9]/gi, ""));
    return `<li class="tunnel-row${on ? " is-active" : ""}" data-id="${id}">
      <span class="tunnel-text"><span class="tunnel-name">${escapeHtml(name)}</span>${on ? ` <span class="tunnel-badge">${escapeHtml(t("In use"))}</span>` : ""}${sub ? `<span class="tunnel-sub">${escapeHtml(sub)}</span>` : ""}</span>
      <span class="tunnel-acts">
        ${on
          ? `<button type="button" class="btn-text" data-act="off" aria-label="${escapeHtml(t("Stop using {name}", { name }))}">${escapeHtml(t("Stop"))}</button>`
          : `<button type="button" class="btn-text" data-act="use" aria-label="${escapeHtml(t("Use {name}", { name }))}">${escapeHtml(t("Use"))}</button>`}
        <button type="button" class="btn-text" data-act="test" aria-label="${escapeHtml(t("Test {name}", { name }))}">${escapeHtml(t("Test"))}</button>
        <button type="button" class="btn-text" data-act="share" aria-label="${escapeHtml(t("Share {name}", { name }))}" title="${escapeHtml(t("Share"))}">${ICON.share}</button>
        <button type="button" class="btn-text" data-act="delete" aria-label="${escapeHtml(t("Delete {name}", { name }))}" title="${escapeHtml(t("Delete"))}" style="color:var(--danger)">${ICON.trash}</button>
      </span>
    </li>`;
  }).join("");
}

/** One list action. Returns true when something changed. Exported for tests. */
export async function wsAction(act, p, { invoke, confirmModal, toast, errToast, onChange, testHost = "", reopen, shareText }) {
  const name = wsProxyName(p);
  switch (act) {
    case "use":
    case "off":
      try {
        await invoke("ws_transport_select", { id: act === "use" ? p.id : null });
      } catch (e) {
        errToast(t("Couldn't switch the transport: {why}", { why: errMsg(e) }), 6000);
        return false;
      }
      await refreshWsTransportStatus(invoke);
      toast(act === "use" ? t("Now using {name}", { name }) : t("WebSocket transport turned off"));
      onChange?.();
      await reopen?.(p.id);
      return true;
    case "test": {
      if (!testHost) { errToast(t("This profile has no mail server to test with"), 5000); return false; }
      toast(t("Testing {name}…", { name }), 2000);
      try {
        const r = await invoke("ws_transport_test", { url: p.url, host: testHost, token: p.token || null });
        if (r?.ips > 0) toast(t("{name} works: {host} found ({ms} ms)", { name, host: testHost, ms: r.ms ?? "?" }), 5000);
        else errToast(t("{name} answered, but doesn't serve {host}", { name, host: testHost }), 6000);
      } catch (e) {
        errToast(t("{name} doesn't answer: {why}", { name, why: errMsg(e) }), 6000);
      }
      return false;
    }
    case "share": {
      const link = buildWsLink(p);
      if (p.token && !(await confirmModal(
        t("Share invite link?"),
        t("This link includes the invite for “{name}”. Anyone who gets it can send traffic through this proxy until its owner revokes the invite. Share it only with people you trust.", { name }),
        t("Share"),
        false,
      ))) { await reopen?.(p.id); return false; }
      try { await shareText?.(link); } catch (e) { errToast(t("Couldn't share: {why}", { why: errMsg(e) })); }
      return false;
    }
    case "delete": {
      const ok = await confirmModal(
        t("Delete WebSocket proxy?"),
        p.id && p.active
          ? t("“{name}” is in use. Deleting it turns the WebSocket transport off and mail connects directly.", { name })
          : t("Delete “{name}”?", { name }),
        t("Delete"),
        true,
      );
      if (!ok) { await reopen?.(p.id); return false; }
      try {
        await invoke("ws_transport_delete", { id: p.id });
      } catch (e) {
        errToast(t("Couldn't delete the proxy: {why}", { why: errMsg(e) }), 6000);
        return false;
      }
      await refreshWsTransportStatus(invoke);
      toast(t("WebSocket proxy deleted"));
      onChange?.();
      await reopen?.();
      return true;
    }
  }
  return false;
}

/** Adds a proxy from the form or a link. activate: also switch to it. */
export async function addWsProxy({ url, label = "", token = "", activate = false }, { invoke, toast, errToast, onChange }) {
  let canon;
  try { canon = normalizeWsProxyUrl(url); }
  catch (e) { errToast(errMsg(e), 5000); return null; }
  try {
    const r = await invoke("ws_transport_add", { url: canon, label: cleanWsLabel(label), token: validWsToken(token) ? token : null, activate });
    await refreshWsTransportStatus(invoke);
    toast(r?.existing ? (token ? t("Invite saved for this proxy") : t("This proxy is already saved")) : activate ? t("WebSocket proxy added and in use") : t("WebSocket proxy added"));
    onChange?.();
    return r;
  } catch (e) {
    errToast(t("Couldn't add the proxy: {why}", { why: errMsg(e) }), 6000);
    return null;
  }
}

/** velta://ws?… : validated, then confirmed (warning about the server). */
export async function acceptWsLink(link, { confirmModal, toast, errToast, onChange, invoke = tauriInvoke(), platform = null }) {
  let parsed;
  try { parsed = parseWsLink(link); }
  catch (e) { errToast(t("This WebSocket link can't be used: {why}", { why: errMsg(e) }), 6000); return false; }
  if (!invoke) return acceptWsLinkPwa(parsed, { confirmModal, toast, errToast });
  let status = null;
  try { status = await invoke("ws_transport_status"); } catch { /* old shell */ }
  const plat = platform || wsTransportPlatform({ tauri: true, status });
  if (!status || !plat.supported) { errToast(plat.text || t("The WebSocket transport is available in the Android and Windows apps"), 6000); return false; }
  const cur = (status.proxies || []).find(p => p.id === status.active);
  const text = wsConfirmText(parsed, { current: cur ? wsProxyName(cur) : null });
  if (!(await confirmModal(t("Use WebSocket proxy?"), text, t("Add and use"), false))) return false;
  return !!(await addWsProxy({ ...parsed, activate: true }, { invoke, toast, errToast, onChange }));
}

/** PWA: an invite link adds its proxy to "WebSocket relays" and uses it. */
export async function acceptWsLinkPwa(parsed, { confirmModal, toast, errToast, reload = () => location.reload() }) {
  const host = wsProxyHost(parsed.url);
  // The PWA's relays are bare wss://<domain> (no port, no path).
  if (!parsed.token || parsed.url !== `wss://${normalizeHost(host)}`) {
    errToast(wsTransportPlatform({ tauri: false }).text, 6000);
    return false;
  }
  const text = [
    ...(parsed.label ? [t("Name: {label}", { label: parsed.label })] : []),
    t("Proxy server: {host}", { host }),
    t("The link includes an invite that lets you use this proxy. Keep it private."),
    t("Mail in this browser will go through this proxy. The page reloads to switch."),
  ].join("\n\n");
  if (!(await confirmModal(t("Use WebSocket proxy?"), text, t("Add and use"), false))) return false;
  const added = addWsRelay(host);
  if (!added) { errToast(t("Bad host name"), 5000); return false; }
  setWsRelayToken(added, parsed.token);
  useWsRelay(added);
  toast(t("WebSocket proxy added and in use"));
  // Always reload: the worker reads the proxy and its invite once, at boot.
  setTimeout(reload, 400);
  return true;
}

/** The settings sheet. deps: showModal, confirmModal, toast, errToast, onChange, testHost, platform. */
export async function openWsTransportSettings(deps) {
  const { showModal, toast, errToast, onChange, invoke = tauriInvoke() } = deps;
  let status = null;
  if (invoke) { try { status = await invoke("ws_transport_status"); } catch { status = null; } }
  const plat = deps.platform || wsTransportPlatform({ tauri: !!invoke, status });
  const body = document.createElement("div");
  if (!plat.supported || !status) {
    body.innerHTML = `<p class="p2p-hint" role="note">${escapeHtml(plat.text || t("The WebSocket transport is available in the Android and Windows apps"))}</p>`;
    return { body, ...showModal({ title: t("WebSocket transport"), body }) };
  }
  body.innerHTML = `
    <p class="bar-opts-hint">${escapeHtml(t("Mail goes through a Velta WebSocket proxy instead of connecting to the relays directly. Useful when only web traffic works. Only one of WebSocket transport and DNS tunnel is in use at a time."))}</p>
    ${status.dns_tunnel_active ? `<p class="p2p-hint" role="note">${escapeHtml(t("The DNS tunnel is in use. Using a WebSocket proxy turns it off."))}</p>` : ""}
    <h3 class="tunnel-list-h" id="ws-list-h">${escapeHtml(t("Saved WebSocket proxies"))}</h3>
    <ul class="tunnel-list" role="list" aria-labelledby="ws-list-h" data-ws-list>${wsListHtml(status)}</ul>
    <form data-ws-add style="display:flex;flex-direction:column;gap:6px;margin-top:10px" novalidate>
      <label for="ws-add-url" class="tunnel-list-h" style="margin:0">${escapeHtml(t("Proxy address"))}</label>
      <input id="ws-add-url" class="text-field" type="url" inputmode="url" autocomplete="off" spellcheck="false" maxlength="${WS_LINK_MAX}" placeholder="wss://proxy.example.org" required aria-describedby="ws-add-err">
      <label for="ws-add-label" class="tunnel-list-h" style="margin:0">${escapeHtml(t("Name (optional)"))}</label>
      <input id="ws-add-label" class="text-field" type="text" autocomplete="off" maxlength="${WS_LABEL_MAX}">
      <p id="ws-add-err" class="bar-opts-hint" role="alert" aria-live="assertive" style="color:var(--danger)"></p>
      <button type="submit" class="btn-text btn-primary">${ICON.plus}<span>${escapeHtml(t("Add and use"))}</span></button>
    </form>`;
  const { close } = showModal({ title: t("WebSocket transport"), body });
  const reopen = focusId => { close(); return openWsTransportSettings({ ...deps, focusId }); };
  if (deps.focusId) {
    setTimeout(() => body.querySelector(`li[data-id="${String(deps.focusId).replace(/[^a-z0-9]/gi, "")}"] button`)?.focus?.(), 80);
  }
  const shareText = async text => {
    try { await invoke("share_text", { text, title: t("Velta WebSocket proxy") }); }
    catch { await navigator.clipboard.writeText(text); toast(t("Link copied")); }
  };
  body.querySelector("[data-ws-list]").addEventListener("click", async ev => {
    const b = ev.target?.closest?.("button[data-act]");
    const id = b?.closest?.("li[data-id]")?.dataset.id;
    const p = id && (status.proxies || []).find(x => x.id === id);
    if (!p) return;
    if (b.dataset.act === "delete" || b.dataset.act === "use" || b.dataset.act === "off") close();
    await wsAction(b.dataset.act, { ...p, active: p.id === status.active }, { ...deps, invoke, reopen, shareText, testHost: deps.testHost || "" });
  });
  const form = body.querySelector("[data-ws-add]");
  form.addEventListener("submit", async ev => {
    ev.preventDefault();
    const url = form.querySelector("#ws-add-url");
    const err = form.querySelector("#ws-add-err");
    // A pasted velta://ws invite link fills address, name and token at once.
    let entry = { url: url.value, label: form.querySelector("#ws-add-label").value, token: "" };
    try {
      if (extractWsLink(url.value)) { const l = parseWsLink(url.value); entry = { ...l, label: entry.label || l.label }; }
      else normalizeWsProxyUrl(url.value);
    }
    catch (e) { err.textContent = errMsg(e); url.setAttribute("aria-invalid", "true"); url.focus(); return; }
    url.removeAttribute("aria-invalid");
    err.textContent = "";
    const r = await addWsProxy({ ...entry, activate: true }, { invoke, toast, errToast, onChange });
    if (r) reopen(r.id);
  });
  return { body, close };
}
