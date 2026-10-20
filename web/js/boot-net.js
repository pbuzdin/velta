// boot-net.js — loaded before every other script so a startup error can
// never be invisible. While app.js is still loading, errors surface in the
// static #boot-error banner; once the Diagnostics sink exists they are
// mirrored there (and into velta.log) instead. Kept as an external classic
// script because the CSP forbids inline scripts (script-src falls back to
// default-src 'self').
(function () {
  "use strict";
  window.__veltaBootErrors = [];
  function surface(msg) {
    try {
      if (window.__veltaDiagnostics) {
        window.__veltaDiagnostics.append("error", msg);
        return;
      }
    } catch {}
    window.__veltaBootErrors.push(String(msg).slice(0, 300));
    if (window.__veltaBootErrors.length > 20) window.__veltaBootErrors.shift();
    var box = document.getElementById("boot-error");
    if (box) {
      box.hidden = false;
      var log = box.querySelector("code");
      if (log) log.textContent = window.__veltaBootErrors.slice(-5).join("\n");
    }
  }
  window.__veltaBootError = surface;
  window.addEventListener("error", function (e) {
    surface((e && (e.message || e.type)) || "script error");
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    surface("async: " + ((r && (r.message || r)) || "promise rejection"));
  });
  window.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("boot-error-reload");
    if (btn) btn.addEventListener("click", function () { location.reload(); });
  });
})();
