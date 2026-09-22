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
  // Android chain: Chrome Custom Tab (InAppBrowser.kt via JNI) → the native
  // second-WebView overlay (no Custom Tabs provider on the device; a
  // top-level context, so X-Frame-Options cannot block it) → the in-app
  // iframe overlay (old shell). The bar's open-external button is the escape
  // hatch in every in-app variant.
  const t = window.__TAURI__;
  if (t && /Android/.test(navigator.userAgent || "")) {
    const invoke = t?.core?.invoke || t?.invoke;
    invoke?.("open_in_app_browser", { url })
      .catch((e) => {
        invoke("js_log", { msg: `open_in_app_browser fell back to the webview overlay: ${e}` }).catch(() => {});
        invoke("open_webview_browser", { url }).catch((e2) => {
          invoke("js_log", { msg: `open_webview_browser fell back to the iframe overlay: ${e2}` }).catch(() => {});
          openIframeOverlay(url);
        });
      });
    return;
  }
  openIframeOverlay(url);
}

function openIframeOverlay(url) {
  // Only web pages: a javascript:/data: src would run in the host's origin.
  if (!/^https?:\/\//i.test(String(url || ""))) return;
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
        <div class="iab-title" data-title></div>
        <div class="iab-domain" data-domain></div>
      </div>
      <button type="button" class="icon-btn" data-external title="Open in system browser" aria-label="Open in system browser">
        <svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 13v6a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
    <div class="iab-progress" data-progress></div>
    <iframe class="iab-frame" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads" referrerpolicy="no-referrer-when-downgrade"></iframe>`;

  // The URL comes from a message: set it through the DOM, never through the
  // HTML template (a quote in the link would break out of the attribute).
  wrap.querySelector("[data-title]").textContent = domain;
  wrap.querySelector("[data-domain]").textContent = domain;
  wrap.querySelector("iframe").src = url;

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
