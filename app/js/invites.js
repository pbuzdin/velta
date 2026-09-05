// invites.js — Delta Chat invite links (https://i.delta.chat/#… and mirrors):
// configurable domain registry, URL parsing/normalization, invite cards in
// chat messages, and the "Invite link domains" settings modal.
import { showModal, toast } from "./ui.js";
import { escapeHtml, escapeAttr } from "./components.js";

// Mirror the AndroidManifest.xml intent filters: OS-level interception of a
// domain is compiled into the app, this list controls what Velta recognizes
// at runtime (OS deep links, pasted links, invite cards in chat messages).
const BUILTIN_HOSTS = ["i.delta.chat", "i.deltachat.id", "i.gluek.info"];
const HOSTS_KEY = "velta-invite-hosts"; // localStorage JSON array of extra hosts
// v3 invite URL: https://<host>/#FINGERPRINT&v=3&x=…&i=…&s=…&a=…&n=…&g=…
// The payload lives in the fragment and is never sent to a server — the host
// is decorative, so mirrors are safe to normalize onto i.delta.chat (the one
// scheme the core's qr.rs accepts).
const CANONICAL_HOST = "i.delta.chat";

export function getExtraHosts() {
  try {
    const list = JSON.parse(localStorage.getItem(HOSTS_KEY) || "[]");
    return Array.isArray(list) ? list.map(h => String(h).toLowerCase()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function setExtraHosts(hosts) {
  localStorage.setItem(HOSTS_KEY, JSON.stringify([...new Set(hosts)]));
}

export function getInviteHosts() {
  return [...new Set([...BUILTIN_HOSTS, ...getExtraHosts()])];
}

export function addInviteHost(host) {
  const clean = normalizeHost(host);
  if (!clean) return null;
  const extra = getExtraHosts();
  if (!extra.includes(clean) && !BUILTIN_HOSTS.includes(clean)) {
    extra.push(clean);
    setExtraHosts(extra);
  }
  return clean;
}

export function removeInviteHost(host) {
  setExtraHosts(getExtraHosts().filter(h => h !== host.toLowerCase()));
}

function normalizeHost(raw) {
  let s = String(raw || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // hostname: labels of letters/digits/hyphens, at least one dot
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) ? s : null;
}

// Parse an invite link / QR text. Accepts:
//   • https://<registered-host>/#FINGERPRINT&v=3&…   (v3, params after the fp)
//   • https://i.delta.chat#FINGERPRINT               (no-slash variant)
//   • OPENPGP4FPR:FINGERPRINT#…                      (QR text form)
// Returns { link, raw, host, fingerprint, params } with `link` normalized to
// the canonical i.delta.chat form the core accepts, or null if not an invite.
export function parseInviteLink(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let host = null;
  let payload = null; // everything after the fingerprint
  let fingerprint = null;
  let canonical = null; // form the core accepts
  if (/^openpgp4fpr:/i.test(s)) {
    const rest = s.slice("openpgp4fpr:".length);
    const [fp, ...restParts] = rest.split("#");
    fingerprint = fp || "";
    payload = restParts.join("#");
    canonical = s; // the core parses OPENPGP4FPR text natively — pass through
  } else {
    let url;
    try { url = new URL(s); } catch { return null; }
    if (url.protocol !== "https:" || !getInviteHosts().includes(url.hostname)) return null;
    host = url.hostname;
    const hash = url.hash.replace(/^#\/?/, ""); // tolerate "/#fp" and "#fp"
    const m = hash.match(/^([0-9A-Fa-f]{40})(?:[&#]([\s\S]*))?$/); // fp, then params joined by & or #
    if (!m) return null;
    fingerprint = m[1];
    payload = m[2] ? "&" + m[2] : "";
    canonical = `https://${CANONICAL_HOST}/#${fingerprint}${payload}`;
  }
  if (!/^[0-9A-Fa-f]{40}$/.test(fingerprint)) return null;
  const params = parseParams(payload);
  return {
    raw: s,
    host: host || CANONICAL_HOST,
    fingerprint,
    params,
    link: canonical,
  };
}

// Fragment params: "v=3&x=…&n=Pavel&g=Chat+RU" — '+' means space (as in the
// core's qr.rs decode_name), values are percent-encoded.
function parseParams(payload) {
  const params = {};
  for (const part of payload.replace(/^[&]/, "").split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = eq === -1 ? part : part.slice(0, eq);
    const value = eq === -1 ? "" : part.slice(eq + 1);
    try {
      params[key.toLowerCase()] = decodeURIComponent(value.replace(/\+/g, "%20"));
    } catch {
      params[key.toLowerCase()] = value;
    }
  }
  return params;
}

// Human-readable label for an invite, straight from the link's own params
// (no network): n= inviter name, a= inviter address, g= group name,
// b= broadcast channel name (core Qr kind AskJoinBroadcast).
// Returns { kind: "group"|"channel"|"person", actor, group, addr }.
export function inviteLabel(parsed) {
  const { params } = parsed;
  const addr = params.a || "";
  const actor = params.n || (addr ? addr.split("@")[0] : "") || "Someone";
  if (params.b) return { kind: "channel", actor, group: params.b, addr };
  return params.g
    ? { kind: "group", actor, group: params.g, addr }
    : { kind: "person", actor, group: null, addr };
}

// HTML for the invite card rendered inside a message bubble. The text part
// asks to join (handled by bindInviteInterception), the right icon copies.
export function inviteCardHtml(parsed) {
  const label = inviteLabel(parsed);
  const line = label.kind === "group"
    ? `<b>${escapeHtml(label.actor)}</b> invited you to a <b>${escapeHtml(label.group)}</b> group`
    : label.kind === "channel"
    ? `Subscribe to <b>${escapeHtml(label.group)}</b>`
    : `Chat with <b>${escapeHtml(label.actor)}</b>`;
  const sub = label.addr && label.addr !== label.actor ? `<span class="invite-sub">${escapeHtml(label.addr)}</span>` : "";
  return `<span class="invite-card">` +
    `<button type="button" class="invite-main" data-invite-join="${escapeAttr(parsed.raw)}">` +
      `<span class="invite-line">${line}</span>${sub}` +
    `</button>` +
    `<button type="button" class="invite-copy" data-invite-copy="${escapeAttr(parsed.raw)}" title="Copy invite link" aria-label="Copy invite link">` +
      `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15V5a2 2 0 012-2h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>` +
    `</button>` +
  `</span>`;
}

// Document-level handling of invite interactions (capture phase, survives
// message re-renders):
//   • .invite-main buttons → onJoin(rawLink)  (app asks to join, then joins)
//   • .invite-copy buttons → copy the raw link
//   • plain <a href> to a registered invite host → onJoin too
export function bindInviteInterception(onJoin) {
  document.addEventListener("click", e => {
    const copyBtn = e.target.closest?.("[data-invite-copy]");
    if (copyBtn) {
      e.preventDefault();
      e.stopPropagation();
      const link = copyBtn.getAttribute("data-invite-copy");
      navigator.clipboard?.writeText(link)?.then?.(() => toast("Invite link copied"));
      return;
    }
    const joinBtn = e.target.closest?.("[data-invite-join]");
    if (joinBtn) {
      e.preventDefault();
      e.stopPropagation();
      onJoin(joinBtn.getAttribute("data-invite-join"));
      return;
    }
    const a = e.target.closest?.('a[href^="http"]');
    if (a) {
      const parsed = parseInviteLink(a.getAttribute("href"));
      if (parsed) {
        e.preventDefault();
        e.stopPropagation();
        onJoin(parsed.raw);
      }
    }
  }, true);
}

// "Invite link domains" settings modal: manage the runtime registry of hosts
// whose links Velta recognizes. Built-ins mirror the compiled-in Android
// intent filters; extra domains work everywhere inside Velta (deep links from
// the OS, invite cards, pasted links).
export function showInviteDomainsModal() {
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="font-size:14.5px;line-height:1.5;margin-bottom:8px">Links on these domains open as chat invites in Velta — in messages they render as invite cards, and pasted links are recognized.</p>
    <div class="modal-list" data-host-list style="max-height:220px;overflow:auto"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <input class="text-field" data-host-input placeholder="mirror.example.org" autocomplete="off" inputmode="url" autocapitalize="none" style="flex:1">
      <button class="btn-text" data-host-add>Add</button>
    </div>
    <p style="font-size:12.5px;line-height:1.45;color:var(--text-dim);margin-top:10px">To have Android offer Velta for a new domain everywhere (e.g. in the browser), it also needs an entry in the app's intent filters — that list is compiled into the APK.</p>`;

  const list = body.querySelector("[data-host-list]");
  const input = body.querySelector("[data-host-input]");

  const renderList = () => {
    list.replaceChildren();
    const rows = [
      ...BUILTIN_HOSTS.map(h => ({ host: h, builtin: true })),
      ...getExtraHosts().map(h => ({ host: h, builtin: false })),
    ];
    for (const row of rows) {
      const item = document.createElement("div");
      item.className = "info-row";
      item.innerHTML = `<span class="v">${escapeHtml(row.host)}${row.builtin ? ' <span style="opacity:.55">(built-in)</span>' : ""}</span>`;
      if (!row.builtin) {
        const rm = document.createElement("button");
        rm.className = "btn-text";
        rm.textContent = "Remove";
        rm.style.color = "var(--danger)";
        rm.addEventListener("click", () => { removeInviteHost(row.host); renderList(); });
        item.appendChild(rm);
      }
      list.appendChild(item);
    }
  };
  renderList();

  const { close } = showModal({ title: "Invite link domains", body });
  body.querySelector("[data-host-add]").addEventListener("click", () => {
    const host = addInviteHost(input.value);
    if (!host) { toast("Enter a plain hostname, e.g. mirror.example.org"); return; }
    input.value = "";
    renderList();
    toast(`${host} added`);
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); body.querySelector("[data-host-add]").click(); }
  });
}
