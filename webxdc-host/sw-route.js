// webxdc-host/sw-route.js — the PWA service worker's webxdc route (Step A,
// docs/research/beam-pwa-research.md). Loaded into sw.js via importScripts
// (scripts/build-pwa.mjs); also loaded by tests/webxdc-pwa.test.mjs.
//
// <scope>webxdc-run/<account>/<msg>/<path>:
//  - iframe navigation  -> loader document (frame.js + webxdc-shim.js inlined)
//    with WEBXDC_FRAME_CSP: `sandbox` WITHOUT allow-same-origin (opaque
//    origin: no access to the PWA's storage or DOM) and no network at all.
//  - top-level navigation -> 403 (apps never run outside the host frame).
//  - subresource from a PWA page -> icon files only (chat cards), fetched
//    from the core through the page; everything else 404s. (Requests made
//    BY the opaque app frame never reach the SW in Chromium — frame.js
//    serves those from blob: URLs.)
// Every other same-scope iframe navigation also gets a `sandbox` CSP, so an
// app frame that navigates itself to a plain PWA URL still lands opaque.
(function (root) {
  "use strict";

  var SANDBOX = "sandbox allow-scripts allow-forms allow-downloads allow-modals";
  var WEBXDC_FRAME_CSP = SANDBOX + "; default-src 'none'; " +
    "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:; " +
    "style-src 'unsafe-inline' blob: data:; img-src blob: data:; media-src blob: data:; " +
    "font-src blob: data:; connect-src blob: data:; worker-src blob:; " +
    "frame-src blob: data:; child-src blob: data:; object-src 'none'; manifest-src 'none'; " +
    "form-action 'none'; base-uri 'none'";
  var FRAME_HEADERS = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": WEBXDC_FRAME_CSP,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };

  // {account, msg, path} for a URL under <scopePath>webxdc-run/, else null.
  function parseRunUrl(href, scopeHref) {
    var url, scope;
    try { url = new URL(href); scope = new URL(scopeHref); } catch (e) { return null; }
    if (url.origin !== scope.origin) return null;
    var prefix = scope.pathname.replace(/\/?$/, "/") + "webxdc-run/";
    if (url.pathname.indexOf(prefix) !== 0) return null;
    var m = /^(\d+)\/(\d+)(?:\/(.*))?$/.exec(url.pathname.slice(prefix.length));
    if (!m) return { bad: true };
    var path = m[3] || "";
    try { path = decodeURIComponent(path); } catch (e) { return { bad: true }; }
    if (path.split("/").indexOf("..") >= 0) return { bad: true };
    return { account: Number(m[1]), msg: Number(m[2]), path: path || "index.html" };
  }

  function inScope(href, scopeHref) {
    try {
      var u = new URL(href), s = new URL(scopeHref);
      return u.origin === s.origin && u.pathname.indexOf(s.pathname) === 0;
    } catch (e) { return false; }
  }

  // Same rule as ICON_PATH_RE in app/js/webxdc-manager.js.
  function isIcon(path) { return /^icon\.[a-z]+$/.test(path); }

  // JSON for an inline script: no "<" (closing tag), no U+2028/9.
  function inlineJson(v) {
    return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }

  function frameHtml(loaderSrc, shimSrc) {
    if (/<\/script|<!--/i.test(loaderSrc)) throw new Error("loader not inlinable");
    return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
      "<script>window.__VELTA_SHIM_SRC=" + inlineJson(shimSrc) + ";</script>" +
      "<script>" + loaderSrc + "</script></head><body></body></html>";
  }

  function textResponse(status, text, extra) {
    var h = { "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "sandbox", "Cache-Control": "no-store" };
    for (var k in extra || {}) h[k] = extra[k];
    return new Response(text, { status: status, headers: h });
  }

  // deps: { scope, readAsset(path) -> Promise<string>, iconBytes(account,msg,path,clientId) -> Promise<Uint8Array|null> }
  // Returns a Promise<Response> when the request is ours, else null.
  function route(request, clientId, deps) {
    var scope = deps.scope;
    if (!inScope(request.url, scope)) return null;
    var run = parseRunUrl(request.url, scope);
    var nav = request.mode === "navigate";
    var dest = request.destination;
    if (nav && (dest === "iframe" || dest === "frame")) {
      if (!run) {
        // Not an app URL: never let a same-origin page load unsandboxed in a
        // frame (an app frame navigating itself, or third-party framing).
        return Promise.resolve(textResponse(403, "Framing is not allowed"));
      }
      if (run.bad) return Promise.resolve(textResponse(400, "bad webxdc path"));
      return Promise.all([deps.readAsset("webxdc-host/frame.js"), deps.readAsset("webxdc-shim.js")])
        .then(function (r) { return new Response(frameHtml(r[0], r[1]), { status: 200, headers: FRAME_HEADERS }); })
        .catch(function () { return textResponse(503, "webxdc loader unavailable"); });
    }
    if (!run) return null;
    if (nav) return Promise.resolve(textResponse(403, "webxdc apps open inside Velta"));
    if (run.bad || request.method !== "GET" || !isIcon(run.path)) return Promise.resolve(textResponse(404, "not found"));
    return deps.iconBytes(run.account, run.msg, run.path, clientId).then(function (bytes) {
      if (!bytes) return textResponse(404, "not found");
      var type = /\.png$/.test(run.path) ? "image/png" : /\.jpe?g$/.test(run.path) ? "image/jpeg" : /\.svg$/.test(run.path) ? "image/svg+xml" : /\.webp$/.test(run.path) ? "image/webp" : "application/octet-stream";
      return new Response(bytes, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600", "Content-Security-Policy": "sandbox; default-src 'none'", "X-Content-Type-Options": "nosniff" } });
    }).catch(function () { return textResponse(404, "not found"); });
  }

  root.veltaWebxdcSw = { route: route, parseRunUrl: parseRunUrl, frameHtml: frameHtml, inlineJson: inlineJson,
    WEBXDC_FRAME_CSP: WEBXDC_FRAME_CSP, isIcon: isIcon };
})(typeof self !== "undefined" ? self : globalThis);
