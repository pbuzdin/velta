// webxdc-shim.js — injected into every webxdc app served through the
// webxdc:// protocol. Implements the window.webxdc API on top of
// postMessage to the host page, which relays to the Delta Chat core
// (status updates) — see app/js/webxdc-manager.js on the host side.
(function () {
  "use strict";
  // WebRTC is off for webxdc apps (spec: no network access; CSP has no
  // portable directive for it — Chromium logs "Unrecognized" and ignores
  // `webrtc 'block'`). The constructors are stubbed BEFORE the app's own
  // scripts run. 🐴 ceiling: a determined app can re-obtain a fresh global
  // (e.g. via a nested about:blank iframe) — this stops accidental use,
  // not a deliberate bypass.
  try {
    const rtcBlocked = function () {
      throw new Error("WebRTC is not available in webxdc apps");
    };
    window.RTCPeerConnection = rtcBlocked;
    window.webkitRTCPeerConnection = rtcBlocked;
  } catch (_e) {
    // no window to guard — nothing to block
  }
  // The host passes the shell theme (?velta-theme=) — apply it as the
  // document's color-scheme so scrollbars and default canvas match. An
  // app's own color-scheme CSS overrides this (inline < author rules with
  // !important, or a later-declared rule on a more specific selector).
  try {
    var t = new URLSearchParams(location.search).get("velta-theme");
    if (t === "dark" || t === "light") document.documentElement.style.colorScheme = t;
  } catch (e) {}
  var serial = 0;
  var listener = null;
  var updates = [];
  var pending = new Map();
  var reqId = 0;
  var info = {
    name: "", document: "", summary: "", sourceCodeUrl: "",
    internetAccess: false, selfAddr: "", selfName: "",
    sendUpdateInterval: 1000, sendUpdateMaxSize: 0,
  };

  // The iframe is sandboxed without allow-same-origin, so the document runs
  // in an opaque origin where touching localStorage/sessionStorage throws
  // SecurityError — and some apps do it at load. Shadow both with an own
  // property backed by memory (webxdc state should live in status updates
  // anyway; this only keeps storage-touching apps from crashing).
  function memStorage() {
    var mem = new Map();
    return {
      getItem: function (k) { k = String(k); return mem.has(k) ? mem.get(k) : null; },
      setItem: function (k, v) { mem.set(String(k), String(v)); },
      removeItem: function (k) { mem.delete(String(k)); },
      clear: function () { mem.clear(); },
      key: function (i) { var ks = Array.from(mem.keys()); return i >= 0 && i < ks.length ? ks[i] : null; },
      get length() { return mem.size; },
    };
  }
  function shadowStorage(name) {
    try { window[name].getItem("__velta-probe"); } catch (e) {
      try { Object.defineProperty(window, name, { value: memStorage(), configurable: false }); } catch (e2) {}
    }
  }
  shadowStorage("localStorage");
  shadowStorage("sessionStorage");

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = "req-" + (++reqId);
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        window.parent.postMessage({ type: "velta-webxdc-call", id: id, method: method, params: params || {} }, "*");
      } catch (e) { pending.delete(id); reject(e); }
    });
  }

  window.addEventListener("message", function (ev) {
    var d = ev.data || {};
    if (d.type === "velta-webxdc-response" && pending.has(d.id)) {
      var p = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) p.reject(new Error(d.error));
      else p.resolve(d.result);
      return;
    }
    if (d.type === "velta-webxdc-status-updates") {
      for (var u of d.updates || []) {
        updates.push(u);
        serial = Math.max(serial, u.serial || 0);
        if (listener) { try { listener(u); } catch (e) {} }
      }
      if (d.done) { var l = listener; listener = null; if (l) l({ serial: serial, maxSerial: serial, done: true }); }
    }
    if (d.type === "velta-webxdc-info" && d.info) {
      Object.assign(info, d.info);
    }
  });

  window.parent.postMessage({ type: "velta-webxdc-call", id: "info", method: "getInfo", params: {} }, "*");

  window.webxdc = {
    selfAddr: "",
    selfName: "",
    xdcName: "",
    getAllUpdates: async function () {
      var r = await call("getAllUpdates", {});
      updates = r.updates || [];
      serial = 0;
      for (var u of updates) serial = Math.max(serial, u.serial || 0);
      return updates;
    },
    setUpdateListener: function (cb, startSerial) {
      serial = startSerial || 0;
      listener = cb;
      call("getStatusUpdates", { serial: serial });
      return Promise.resolve();
    },
    sendUpdate: async function (update, description) {
      await call("sendUpdate", { update: update, description: description || "" });
    },
    sendToChat: async function (message) {
      // Spec: sendToChat({ file: {name, blob|base64}, text? }) — text-only
      // sends are allowed too, and some older apps pass the File itself.
      // Normalize everything to {file: Blob, name, text}; the Blob rides the
      // postMessage bridge (structured clone); the host confirms, stages it
      // under uploads/ and sends it as a message into the chat.
      var m = message instanceof Blob ? { file: message } : message || {};
      var file = null;
      var name = m.name || "";
      if (m.file instanceof Blob) { file = m.file; name = m.file.name || name; }
      else if (m.file && m.file.blob instanceof Blob) { file = m.file.blob; name = m.file.name || name; }
      else if (m.file && typeof m.file.base64 === "string") {
        try {
          var bin = atob(m.file.base64);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          file = new Blob([arr]);
          name = m.file.name || name;
        } catch (e) {}
      }
      if (!file && !m.text) return { ok: false, error: "nothing to send" };
      if (!name) name = (file && file.name) || "file";
      var r = await call("sendToChat", { file: file, name: name, type: (file && file.type) || "", text: m.text || "" });
      return r && typeof r === "object" ? r : { ok: false };
    },
    importFiles: async function (filters) {
      // Host opens the system picker (tauri dialog, same as chat attachments)
      // and returns File objects — they ride the postMessage bridge back.
      return (await call("importFiles", { filters: filters || {} })) || [];
    },
    getSelfInfo: async function () {
      await call("getInfo", {}).then(function (i) { Object.assign(info, i || {}); });
      return { addr: info.selfAddr, name: info.selfName, color: "#7d8a99" };
    },
    listRealtimeAdapters: function () { return []; },
  };
  Object.defineProperty(window.webxdc, "selfInfo", { get: function () { return { addr: info.selfAddr, name: info.selfName }; } });
  Object.defineProperty(window.webxdc, "myAddr", { get: function () { return info.selfAddr; } });
  Object.defineProperty(window.webxdc, "sendUpdateInterval", { get: function () { return info.sendUpdateInterval; } });
  Object.defineProperty(window.webxdc, "sendUpdateMaxSize", { get: function () { return info.sendUpdateMaxSize; } });
})();
