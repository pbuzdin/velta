// webxdc-shim.js — injected into every webxdc app served through the
// webxdc:// protocol. Implements the window.webxdc API on top of
// postMessage to the host page, which relays to the Delta Chat core
// (status updates) — see app/js/webxdc-manager.js on the host side.
(function () {
  "use strict";
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
    sendToChat: async function (file) {
      var r = await call("sendToChat", { name: file && file.name, type: file && file.type });
      return r && typeof r === "object" ? r : { ok: false };
    },
    importFiles: async function () { return []; },
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
