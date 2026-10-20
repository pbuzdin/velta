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
    // No capture either (Phase 0, docs/research/webxdc-group-calls.md):
    // the browser already refuses it in the opaque origin; this makes the
    // refusal uniform (NotAllowedError) on every shell.
    var md = navigator.mediaDevices;
    if (md) {
      var deny = function () {
        return Promise.reject(new DOMException("Media capture is not available in webxdc apps", "NotAllowedError"));
      };
      ["getUserMedia", "getDisplayMedia"].forEach(function (k) {
        try { Object.defineProperty(md, k, { value: deny, configurable: false, writable: false }); } catch (_e2) {}
      });
    }
    if (navigator.getUserMedia) navigator.getUserMedia = function (_c, _ok, err) { if (err) err(new DOMException("denied", "NotAllowedError")); };
  } catch (_e) {
    // no window to guard — nothing to block
  }
  // Never set color-scheme on the app document. Forcing the shell's dark
  // scheme here made browser defaults (text color, form controls, canvas)
  // dark while apps that only set a white background kept the default
  // text color → white on white. Apps get the web default (light) like in
  // Delta Chat; prefers-color-scheme follows the iframe element's
  // color-scheme (the Velta theme, main.css .webxdc-frame), and Chromium
  // paints an opaque canvas in the document's own scheme when they differ.
  var serial = 0;
  var listener = null;
  var updates = [];
  var pending = new Map();
  var reqId = 0;
  var rt = null; // the realtime channel (one per app, spec)
  var callState = null; // webxdc.veltaCall (trusted group-call app only)
  var callListeners = [];
  var info = {
    name: "", document: "", summary: "", sourceCodeUrl: "",
    internetAccess: false, selfAddr: "", selfName: "",
    sendUpdateInterval: 1000, sendUpdateMaxSize: 0,
    veltaRealtime: true, // false in the Velta web app (PWA) until iroh runs in wasm
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

  // Hand updates newer than `serial` to the app's listener, once each, in
  // order. The listener stays registered for the app's lifetime (spec):
  // it used to be dropped after the first batch — and called with a fake
  // payload-less {done} object — so a poll's own votes never showed and a
  // reopened app never got its stored updates (the getStatusUpdates
  // result was discarded).
  function deliver(list) {
    var sorted = (list || []).slice().sort(function (a, b) { return (a.serial || 0) - (b.serial || 0); });
    for (var u of sorted) {
      if (!u || (u.serial || 0) <= serial) continue;
      updates.push(u);
      serial = u.serial || serial;
      if (listener) { try { listener(u); } catch (e) {} }
    }
  }

  window.addEventListener("message", function (ev) {
    var d = ev.data || {};
    if (d.type === "velta-webxdc-response" && d.id === "info") {
      if (d.result) Object.assign(info, d.result); // the eager getInfo below
      return;
    }
    if (d.type === "velta-webxdc-response" && pending.has(d.id)) {
      var p = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) p.reject(new Error(d.error));
      else p.resolve(d.result);
      return;
    }
    if (d.type === "velta-webxdc-status-updates") {
      deliver(d.updates);
      return;
    }
    if (d.type === "velta-webxdc-realtime") {
      if (rt && !rt.left && rt.cb) { try { rt.cb(d.data); } catch (e) {} }
      return;
    }
    if (d.type === "velta-call-state") {
      callState = d.state || null;
      callListeners.forEach(function (cb) { try { cb(callState); } catch (e) {} });
      return;
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
      serial = Number(startSerial) || 0;
      listener = typeof cb === "function" ? cb : null;
      // Resolves once every stored update after startSerial was delivered.
      return call("getStatusUpdates", { serial: serial }).then(function (r) {
        deliver(r && r.updates);
      }, function () {});
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
    // Velta extension, group calls (docs/agents/group-calls.md): the HOST
    // owns the mic and the connections; the app only drives them. The host
    // answers these calls only for the built-in group-call app (bundle hash
    // on the trusted list); for every other app available() is false and
    // the methods reject. Never a WebRTC/mic grant to the frame.
    veltaCall: {
      available: function () { return call("getInfo", {}).then(function (i) { return !!(i && i.veltaCall); }, function () { return false; }); },
      join: function () { return call("veltaCallJoin", {}); },
      leave: function () { return call("veltaCallLeave", {}); },
      setMuted: function (on) { return call("veltaCallMute", { muted: !!on }); },
      getTheme: function () { return call("getInfo", {}).then(function (i) { return (i && i.veltaTheme) || null; }); },
      getState: function () { return call("veltaCallState", {}).then(function (s) { callState = s || null; return callState; }); },
      onState: function (cb) { if (typeof cb === "function") { callListeners.push(cb); if (callState) { try { cb(callState); } catch (e) {} } } },
    },
    // Spec (webxdc.d.ts): one channel per app; send(Uint8Array <= 128000),
    // setListener(cb(Uint8Array)), leave(). Backed by the core's iroh
    // gossip topic for this instance (host: webxdc-manager realtime*).
    joinRealtimeChannel: function () {
      if (rt && !rt.left) throw new Error("realtime channel already joined");
      // Host said realtime is unavailable (Velta web app: no iroh in wasm
      // yet) — fail loudly instead of a channel that never delivers.
      if (info.veltaRealtime === false) throw new Error("Direct transfer (realtime channels) is not available in the Velta web app yet");
      var ch = { left: false, cb: null };
      rt = ch;
      var joined = call("realtimeJoin", {});
      joined.catch(function () {});
      return {
        setListener: function (cb) { ch.cb = typeof cb === "function" ? cb : null; },
        send: function (data) {
          if (ch.left) throw new Error("realtime channel left");
          if (!(data instanceof Uint8Array)) throw new Error("realtime data must be a Uint8Array");
          if (data.byteLength > 128000) throw new Error("realtime data too large");
          var copy = new Uint8Array(data);
          joined.then(function () { return call("realtimeSend", { data: copy }); }).catch(function () {});
        },
        leave: function () {
          if (ch.left) return;
          ch.left = true;
          ch.cb = null;
          call("realtimeLeave", {}).catch(function () {});
        },
      };
    },
  };
  Object.defineProperty(window.webxdc, "selfInfo", { get: function () { return { addr: info.selfAddr, name: info.selfName }; } });
  Object.defineProperty(window.webxdc, "myAddr", { get: function () { return info.selfAddr; } });
  Object.defineProperty(window.webxdc, "sendUpdateInterval", { get: function () { return info.sendUpdateInterval; } });
  // Velta extension (not in the webxdc spec): false when realtime channels
  // cannot work on this host (the PWA today). Read after getSelfInfo().
  Object.defineProperty(window.webxdc, "veltaRealtimeAvailable", { get: function () { return info.veltaRealtime !== false; } });
  Object.defineProperty(window.webxdc, "sendUpdateMaxSize", { get: function () { return info.sendUpdateMaxSize; } });
})();
