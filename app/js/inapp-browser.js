// inapp-browser.js — Telegram-style internal browser for message links.
//
// Opens https links in a fullscreen overlay: Telegram-like bar (close,
// title/domain, open-in-system-browser) over a sandboxed iframe. The page
// title is fetched out-of-band by the fetch_page_title command — a
// cross-origin iframe's document title is unreadable from here. Sites that
// refuse framing (X-Frame-Options / frame-ancestors) show an empty frame;
// the bar's external-open button is the always-working escape hatch.

const STYLE_ID = "inapp-browser-styles";

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #inapp-browser {
      position: fixed; inset: 0; z-index: 900;
      display: flex; flex-direction: column;
      background: var(--bg-sidebar);
    }
    .iab-bar {
      display: flex; align-items: center; gap: 4px;
      padding: max(env(safe-area-inset-top), 8px) 8px 8px;
      color: var(--text); border-bottom: 1px solid var(--border);
      position: relative; flex: none;
    }
    .iab-meta { flex: 1; min-width: 0; text-align: center; line-height: 1.25; }
    .iab-title { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .iab-domain { font-size: 12px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .iab-progress { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; overflow: hidden; }
    .iab-progress::before {
      content: ""; display: block; height: 100%; width: 40%;
      background: var(--accent); border-radius: 2px;
      animation: iab-slide 1s ease-in-out infinite;
    }
    @keyframes iab-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }
    .iab-frame { flex: 1; border: 0; width: 100%; background: #fff; }`;
  document.head.appendChild(s);
}

export function openInAppBrowser(url) {
  // Android: prefer a native Chrome Custom Tab (InAppBrowser.kt via JNI) —
  // real WebView rendering, no frame-blocking, native title/share/menu; this
  // is what the Telegram-style screenshot actually is. The iframe overlay
  // stays as the fallback (no shell, Custom Tabs launch failure, dev).
  const t = window.__TAURI__;
  if (t && /Android/.test(navigator.userAgent || "")) {
    (t?.core?.invoke || t?.invoke)?.("open_in_app_browser", { url })
      .catch(() => openIframeOverlay(url));
    return;
  }
  openIframeOverlay(url);
}

function openIframeOverlay(url) {
  injectStyles();
  document.getElementById("inapp-browser")?.remove();

  let domain = url;
  try { domain = new URL(url).hostname; } catch {}

  const wrap = document.createElement("div");
  wrap.id = "inapp-browser";
  wrap.innerHTML = `
    <div class="iab-bar">
      <button type="button" class="icon-btn" data-close title="Close" aria-label="Close">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      </button>
      <div class="iab-meta">
        <div class="iab-title" data-title>${domain}</div>
        <div class="iab-domain" data-domain>${domain}</div>
      </div>
      <button type="button" class="icon-btn" data-external title="Open in system browser" aria-label="Open in system browser">
        <svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 13v6a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
    <div class="iab-progress" data-progress></div>
    <iframe class="iab-frame" src="${url}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads" referrerpolicy="no-referrer-when-downgrade"></iframe>`;

  const closeNow = () => wrap.remove();
  const onPop = () => closeNow();
  window.addEventListener("popstate", onPop, { once: true });
  wrap.querySelector("[data-close]").addEventListener("click", () => {
    window.removeEventListener("popstate", onPop);
    closeNow();
    if (history.state?.velta === "inapp-browser") history.back();
  });
  wrap.querySelector("[data-external]").addEventListener("click", () => {
    const t = window.__TAURI__;
    (t?.core?.invoke || t?.invoke)?.("plugin:opener|open_url", { url }).catch(() => {});
  });

  const progress = wrap.querySelector("[data-progress]");
  wrap.querySelector("iframe").addEventListener("load", () => progress.remove());

  // Title: fetch_page_title is best-effort — keep the domain until it answers.
  const titleEl = wrap.querySelector("[data-title]");
  const t = window.__TAURI__;
  (t?.core?.invoke || t?.invoke)?.("fetch_page_title", { url })
    .then((title) => { if (title) titleEl.textContent = title; })
    .catch(() => {});

  document.body.appendChild(wrap);
  // Android BACK closes the viewer like every other overlay.
  if (history.state?.velta !== "inapp-browser") history.pushState({ velta: "inapp-browser" }, "");
}
