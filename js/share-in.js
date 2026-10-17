// #97 share-in. The shell hands the page whatever another app shared:
// Android (tao) turns ACTION_SEND text into data:text/plain,… or an https
// URL, and files into content:// or file://. Windows Send to passes a path.
// Invite and chat links are not shares — the deeplink router owns those.

export function parseSharePayload(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const data = /^data:text\/plain(?:;[^,]*)?,(.*)$/is.exec(s);
  if (data) {
    let text = data[1];
    try { text = decodeURIComponent(text); } catch { /* already plain */ }
    return text.length ? { text } : null;
  }
  if (/^content:\/\//i.test(s)) return { file: s };
  if (/^file:/i.test(s)) {
    try {
      const u = new URL(s);
      let p = decodeURIComponent(u.pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      return p ? { file: p } : null;
    } catch { return null; }
  }
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\") || (s.startsWith("/") && !s.startsWith("//"))) {
    return { file: s };
  }
  return null;
}

// Schemes the deeplink router owns. An unconsumed one (a stale chat link,
// a bad invite) is dropped, not shared as text.
const APP_SCHEMES = /^(velta|dcaccount|dclogin|dcbackup|openpgp4fpr|data|content|file):/i;

// A shared page URL arrives as https://, which is also how invite links
// arrive. Only the ones the deeplink router did not consume are text shares.
// tao also hands over any EXTRA_TEXT that parses as a URL as-is ("Re: x"
// parses as scheme "re"), so other unconsumed schemes are text as well.
export function shareTextIfUnconsumed(raw, consumed) {
  if (consumed) return null;
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return { text: s };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) || APP_SCHEMES.test(s)) return null;
  let text = s;
  try { text = decodeURIComponent(s); } catch { /* keep as is */ }
  return { text };
}

export function shareViewtype(name) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) return "video";
  if (["mp3", "m4a", "ogg", "opus", "wav", "flac"].includes(ext)) return "audio";
  return "file";
}

// Chats a share can go to: not the device/diagnostics chat, not a contact
// request, not a read-only chat. query narrows by name (picker search).
export function shareTargets(chats, query = "") {
  const q = String(query || "").trim().toLowerCase();
  return (chats || []).filter(c => c
    && !["deaddrop", "device"].includes(c.kind)
    && !c.readOnly
    && (!q || String(c.name || "").toLowerCase().includes(q)));
}

// One share burst -> the caption text and the distinct files, in order.
export function sharePlan(items) {
  const list = (items || []).filter(i => i && (i.text != null || i.file));
  const text = list.filter(i => i.text != null && String(i.text).length).map(i => String(i.text)).join("\n\n");
  const files = [...new Set(list.filter(i => i.file).map(i => i.file))];
  return { text, files };
}

const STAGE_IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

// How the chosen chat receives it, from the resolved paths: "text" (text
// only, into the composer), "image"/"video" (one photo/video into the
// attachment strip, the text as caption: the user reviews and taps Send),
// or "send" (documents and several files go out right away).
export function shareStageKind(paths) {
  const list = paths || [];
  if (!list.length) return "text";
  if (list.length > 1) return "send";
  const base = String(list[0] || "").replace(/\\/g, "/").split("/").pop();
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (STAGE_IMAGE.includes(ext)) return "image";
  if (dot > 0 && shareViewtype(base) === "video") return "video";
  return "send";
}

// Shares that arrive before the app can show them (a cold start from the
// share sheet lands before the chat list) are held until ready(); then
// each burst runs once, in order, never two pickers at a time.
export function createShareInbox(run, onError = () => {}) {
  let isReady = false;
  let held = [];
  let chain = Promise.resolve();
  const flush = () => {
    if (!isReady || !held.length) return chain;
    const batch = held;
    held = [];
    chain = chain.then(() => run(batch)).catch(onError);
    return chain;
  };
  return {
    push(items) {
      const batch = (items || []).filter(i => i && (i.text != null || i.file));
      if (batch.length) held.push(...batch);
      return flush();
    },
    ready() { isReady = true; return flush(); },
    get pending() { return held.length; },
    get isReady() { return isReady; },
  };
}

// The "Share to…" body: a search field, a profile row when there are
// several profiles, and the chat list. makeItem(chat) builds one row
// (velta-chat-item in the app). onPick({ chat }) or onPick({ accountId }).
export function buildSharePicker(doc, { chats, accounts = [], currentAccountId = null, makeItem, onPick }) {
  const root = doc.createElement("div");
  root.className = "share-picker";
  const search = doc.createElement("input");
  search.type = "search";
  search.className = "text-field share-search";
  search.placeholder = "Search chats";
  search.setAttribute("aria-label", "Search chats");
  root.appendChild(search);
  if (accounts.length > 1) {
    const row = doc.createElement("div");
    row.className = "share-accounts";
    for (const a of accounts) {
      const b = doc.createElement("button");
      b.type = "button";
      const current = String(a.id) === String(currentAccountId);
      b.className = current ? "share-account current" : "share-account";
      b.textContent = a.name || a.addr || `Profile ${a.id}`;
      b.setAttribute("aria-pressed", current ? "true" : "false");
      if (!current) b.addEventListener("click", () => onPick({ accountId: a.id }));
      row.appendChild(b);
    }
    root.appendChild(row);
  }
  const list = doc.createElement("div");
  list.className = "modal-list share-list";
  root.appendChild(list);
  const render = () => {
    const rows = shareTargets(chats, search.value).map(chat => {
      const item = makeItem(chat);
      item.addEventListener("click", () => onPick({ chat }));
      return item;
    });
    if (!rows.length) {
      const empty = doc.createElement("div");
      empty.className = "side-view-empty";
      empty.textContent = String(search.value || "").trim() ? "No matching chat." : "No chat to share to.";
      rows.push(empty);
    }
    list.replaceChildren(...rows);
  };
  search.addEventListener("input", render);
  render();
  return { el: root, search, list, render };
}
