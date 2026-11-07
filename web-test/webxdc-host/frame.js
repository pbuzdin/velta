// webxdc-host/frame.js — webxdc loader for the wasm PWA (Step A of
// docs/research/beam-pwa-research.md). Runs INSIDE the app iframe.
//
// The service worker answers the frame's navigation to
// <scope>webxdc-run/<account>/<msg>/<path> with a tiny document that inlines
// this file and webxdc-shim.js, sent with a CSP `sandbox` header (no
// allow-same-origin) — so this document has an OPAQUE origin and cannot
// reach the PWA's IndexedDB/OPFS/caches/cookies or the parent DOM.
//
// Chromium does not route an opaque-origin document's subresource requests
// through the service worker (verified: they go straight to the network),
// so the SW cannot serve the app's files the way webxdc:// does natively.
// Instead the loader asks the host page (postMessage, the same bridge the
// shim uses) for the .xdc archive, unzips it here, turns every file into a
// blob: URL owned by this opaque origin, rewrites the app's HTML/CSS/ES
// module references to those blob: URLs, and patches fetch/XHR/element
// src setters so runtime-relative URLs resolve too. The CSP allows only
// blob:/data: — no network at all, not even the PWA origin.
//
// Classic script; must never contain the closing-script-tag or HTML-comment
// open sequences (the SW inlines it in a script element; tested).
(function () {
  "use strict";

  var MIME = {
    html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript",
    css: "text/css", json: "application/json", map: "application/json", txt: "text/plain",
    md: "text/plain", csv: "text/csv", xml: "application/xml", svg: "image/svg+xml",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp",
    wasm: "application/wasm", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
    otf: "font/otf", mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav",
    m4a: "audio/mp4", opus: "audio/ogg", mp4: "video/mp4", webm: "video/webm",
    pdf: "application/pdf", toml: "text/plain",
  };
  function mimeFor(path) {
    var ext = String(path).split(".").pop().toLowerCase();
    return MIME[ext] || "application/octet-stream";
  }

  // Normalized archive path, or null for anything escaping the root.
  function normPath(p) {
    var parts = [];
    var segs = String(p).replace(/\\/g, "/").split("/");
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s === "" || s === ".") continue;
      if (s === "..") { if (!parts.length) return null; parts.pop(); continue; }
      parts.push(s);
    }
    return parts.join("/");
  }

  // Minimal zip reader (stored + deflate via DecompressionStream). The
  // archive is untrusted: it is parsed here, inside the sandbox.
  async function unzip(bytes, inflateRaw) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip archive");
    var count = dv.getUint16(eocd + 10, true);
    var off = dv.getUint32(eocd + 16, true);
    var files = new Map();
    var dec = new TextDecoder();
    for (var n = 0; n < count; n++) {
      if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) throw new Error("bad zip directory");
      var method = dv.getUint16(off + 10, true);
      var csize = dv.getUint32(off + 20, true);
      var nameLen = dv.getUint16(off + 28, true);
      var extraLen = dv.getUint16(off + 30, true);
      var commentLen = dv.getUint16(off + 32, true);
      var local = dv.getUint32(off + 42, true);
      var name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
      off += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith("/")) continue;
      var path = normPath(name);
      if (!path) continue;
      if (dv.getUint32(local, true) !== 0x04034b50) throw new Error("bad zip entry " + path);
      var start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      var raw = u8.subarray(start, start + csize);
      var data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else continue; // unsupported compression: the file is just missing
      files.set(path, data);
    }
    return files;
  }

  async function inflateRawStream(raw) {
    var ds = new DecompressionStream("deflate-raw");
    var out = new Blob([raw]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(out).arrayBuffer());
  }

  // The virtual file system: archive paths -> blob: URLs, resolved against
  // the frame's virtual URL (<origin><appBasePath><path>).
  function createVfs(files, opts) {
    var origin = opts.origin;
    var appBase = opts.appBasePath; // "/…/webxdc-run/<a>/<m>/"
    var scopePath = opts.scopePath || "/"; // PWA scope path ("/" or "/app/")
    var makeUrl = opts.createObjectURL;
    var shimAlias = "/* webxdc.js is provided by the Velta host */";
    var plain = new Map();
    var modules = new Map();
    var building = new Set();

    function virtualUrl(path) { return origin + appBase + path; }

    // Absolute/relative reference -> archive path (or null: not ours).
    function toPath(ref, base) {
      var abs;
      try { abs = new URL(String(ref), base || virtualUrl("index.html")); } catch (e) { return null; }
      if (abs.origin !== origin) return null; // blob:/data:/remote: leave alone (CSP decides)
      var p = abs.pathname;
      var rel;
      if (p.indexOf(appBase) === 0) rel = p.slice(appBase.length);
      else if (p.indexOf(scopePath) === 0) rel = p.slice(scopePath.length); // vite base "/" apps
      else rel = p.replace(/^\/+/, "");
      try { rel = decodeURIComponent(rel); } catch (e) {}
      rel = normPath(rel);
      if (rel === null) return null;
      if (rel === "") rel = "index.html";
      return rel;
    }
    function hashOf(ref) { var i = String(ref).indexOf("#"); return i < 0 ? "" : String(ref).slice(i); }

    function blobFor(path, text, type) {
      return makeUrl(new Blob([text], { type: type }));
    }

    function plainUrl(path) {
      if (plain.has(path)) return plain.get(path);
      if (path === "webxdc.js" || path === "__velta-shim.js") {
        var s = blobFor(path, shimAlias, "text/javascript");
        plain.set(path, s);
        return s;
      }
      var bytes = files.get(path);
      if (!bytes) return null;
      var url;
      if (/\.css$/i.test(path)) {
        plain.set(path, null); // cycle guard (@import loops)
        url = blobFor(path, rewriteCss(new TextDecoder().decode(bytes), virtualUrl(path)), "text/css");
      } else {
        url = blobFor(path, bytes, mimeFor(path));
      }
      plain.set(path, url);
      return url;
    }

    function moduleUrl(path) {
      if (modules.has(path)) return modules.get(path);
      if (path === "webxdc.js" || path === "__velta-shim.js") return plainUrl(path);
      var bytes = files.get(path);
      if (!bytes) return null;
      if (building.has(path)) throw new Error("static import cycle through " + path + " is not supported in the Velta web app");
      building.add(path);
      try {
        var src = rewriteModule(new TextDecoder().decode(bytes), virtualUrl(path));
        var url = blobFor(path, src, "text/javascript");
        modules.set(path, url);
        return url;
      } finally { building.delete(path); }
    }

    // Reference -> blob: URL for a classic resource, or null (leave as is).
    function mapUrl(ref, base) {
      var path = toPath(ref, base);
      if (path === null) return null;
      var url = plainUrl(path);
      return url ? url + hashOf(ref) : null;
    }
    function mapModule(ref, base) {
      var path = toPath(ref, base);
      if (path === null) return null;
      return moduleUrl(path);
    }

    function rewriteCss(css, base) {
      css = css.replace(/@import\s+(["'])([^"']+)\1/g, function (m, q, ref) {
        var u = mapUrl(ref, base);
        return u ? "@import " + q + u + q : m;
      });
      return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, function (m, q, ref) {
        if (/^(data:|blob:|#)/i.test(ref.trim())) return m;
        var u = mapUrl(ref.trim(), base);
        return u ? "url(" + q + u + q + ")" : m;
      });
    }

    // ES modules: relative specifiers resolve against the importing module's
    // URL, which is a non-hierarchical blob: URL here — so rewrite static
    // specifiers to blob: URLs, route import() through the loader, and pin
    // import.meta.url to the module's virtual URL (new URL("x", import.meta.url)
    // then resolves to a path the runtime patches map). Regex-based: an
    // import-looking string inside a string literal/comment is rewritten too.
    function rewriteModule(src, base) {
      src = src.replace(/\bimport\.meta\.url\b/g, JSON.stringify(base));
      src = src.replace(/(\bfrom\s*|\bimport\s*)(["'])((?:\.{1,2}\/|\/)[^"'\n]*)\2/g, function (m, kw, q, ref) {
        var u = mapModule(ref, base);
        return u ? kw + q + u + q : m;
      });
      var dyn = false;
      src = src.replace(/(^|[^\w$.])import\s*\(/g, function (m, pre) { dyn = true; return pre + "__veltaImport("; });
      if (dyn) src = "const __veltaImport = (s) => globalThis.__veltaDynImport(s, " + JSON.stringify(base) + ");\n" + src;
      return src;
    }

    return {
      files: files, toPath: toPath, mapUrl: mapUrl, mapModule: mapModule,
      rewriteCss: rewriteCss, rewriteModule: rewriteModule, virtualUrl: virtualUrl,
    };
  }

  var URL_ATTRS = {
    IMG: ["src"], SCRIPT: ["src"], LINK: ["href"], SOURCE: ["src"], AUDIO: ["src"],
    VIDEO: ["src", "poster"], TRACK: ["src"], INPUT: ["src"], EMBED: ["src"], OBJECT: ["data"],
  };

  function mapElementAttr(vfs, el, attr, value, base) {
    var tag = el.tagName;
    if (tag === "SCRIPT" && attr === "src" && String(el.getAttribute("type") || "").toLowerCase() === "module") {
      return vfs.mapModule(value, base);
    }
    if (tag === "LINK" && attr === "href" && /\bmodulepreload\b/i.test(el.getAttribute("rel") || "")) {
      return vfs.mapModule(value, base);
    }
    return vfs.mapUrl(value, base);
  }

  function mapSrcset(vfs, value, base) {
    return String(value).split(",").map(function (part) {
      var bits = part.trim().split(/\s+/);
      if (!bits[0]) return part;
      var u = vfs.mapUrl(bits[0], base);
      if (u) bits[0] = u;
      return bits.join(" ");
    }).join(", ");
  }

  // Rewrite a parsed app document in place; returns it.
  function rewriteDocument(vfs, doc, base) {
    var metas = doc.querySelectorAll('meta[http-equiv]');
    for (var i = 0; i < metas.length; i++) {
      // The app's own CSP would block the blob: URLs; the frame's header CSP
      // (no network) still applies on top.
      if (/content-security-policy/i.test(metas[i].getAttribute("http-equiv"))) metas[i].remove();
    }
    var all = doc.querySelectorAll("*");
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      var attrs = URL_ATTRS[el.tagName];
      if (attrs) {
        for (var k = 0; k < attrs.length; k++) {
          var v = el.getAttribute(attrs[k]);
          if (v == null || v === "") continue;
          var u = mapElementAttr(vfs, el, attrs[k], v, base);
          if (u) el.setAttribute(attrs[k], u);
        }
      }
      if ((el.tagName === "IMG" || el.tagName === "SOURCE") && el.hasAttribute("srcset")) {
        el.setAttribute("srcset", mapSrcset(vfs, el.getAttribute("srcset"), base));
      }
      if (el.tagName === "STYLE") el.textContent = vfs.rewriteCss(el.textContent, base);
      if (el.hasAttribute && el.hasAttribute("style")) el.setAttribute("style", vfs.rewriteCss(el.getAttribute("style"), base));
      if (el.tagName === "SCRIPT" && !el.hasAttribute("src") && String(el.getAttribute("type") || "").toLowerCase() === "module") {
        el.textContent = vfs.rewriteModule(el.textContent, base);
      }
    }
    return doc;
  }

  // Runtime: references the app creates after load (fetch, XHR, new Image,
  // element.src = "x.png", innerHTML) are mapped on the way out.
  function installRuntime(win, vfs) {
    var pageBase = function () { return win.location.href; };
    win.__veltaDynImport = function (spec, base) {
      var u = null;
      try { u = vfs.mapModule(spec, base); } catch (e) { return Promise.reject(e); }
      return import(u || spec);
    };
    var origFetch = win.fetch;
    if (origFetch) {
      win.fetch = function (input, init) {
        try {
          var url = typeof input === "string" || input instanceof win.URL ? String(input) : input && input.url;
          var method = (init && init.method) || (input && input.method) || "GET";
          if (url && String(method).toUpperCase() === "GET") {
            var m = vfs.mapUrl(url, pageBase());
            if (m) return origFetch.call(win, m, init && init.signal ? { signal: init.signal } : undefined);
            if (vfs.toPath(url, pageBase()) !== null) return Promise.resolve(new win.Response("not found", { status: 404 }));
          }
        } catch (e) {}
        return origFetch.apply(win, arguments);
      };
    }
    var XHR = win.XMLHttpRequest;
    if (XHR) {
      var open = XHR.prototype.open;
      XHR.prototype.open = function (method, url) {
        var args = Array.prototype.slice.call(arguments);
        try {
          if (String(method).toUpperCase() === "GET") {
            var m = vfs.mapUrl(url, pageBase());
            if (m) args[1] = m;
          }
        } catch (e) {}
        return open.apply(this, args);
      };
    }
    function patchProp(Ctor, prop) {
      if (!Ctor) return;
      var d = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
      if (!d || !d.set) return;
      Object.defineProperty(Ctor.prototype, prop, {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) {
          var m = null;
          try { m = mapElementAttr(vfs, this, prop, v, pageBase()); } catch (e) {}
          d.set.call(this, m || v);
        },
      });
    }
    patchProp(win.HTMLImageElement, "src");
    patchProp(win.HTMLScriptElement, "src");
    patchProp(win.HTMLLinkElement, "href");
    patchProp(win.HTMLSourceElement, "src");
    patchProp(win.HTMLMediaElement, "src");
    patchProp(win.HTMLVideoElement, "poster");
    patchProp(win.HTMLTrackElement, "src");
    patchProp(win.HTMLInputElement, "src");
    var setAttr = win.Element.prototype.setAttribute;
    win.Element.prototype.setAttribute = function (name, value) {
      try {
        var attrs = URL_ATTRS[this.tagName];
        var n = String(name).toLowerCase();
        if (attrs && attrs.indexOf(n) >= 0) {
          var m = mapElementAttr(vfs, this, n, value, pageBase());
          if (m) return setAttr.call(this, name, m);
        }
      } catch (e) {}
      return setAttr.call(this, name, value);
    };
    var W = win.Worker;
    if (W) {
      win.Worker = function (url, options) {
        var m = null;
        try { m = options && options.type === "module" ? vfs.mapModule(url, pageBase()) : vfs.mapUrl(url, pageBase()); } catch (e) {}
        return new W(m || url, options);
      };
      win.Worker.prototype = W.prototype;
    }
    // innerHTML / insertAdjacentHTML create elements without the setters:
    // fix them up as they land (the first, unmapped request is CSP-blocked).
    if (win.MutationObserver) {
      new win.MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes;
          for (var j = 0; j < added.length; j++) fixTree(added[j]);
        }
      }).observe(win.document, { childList: true, subtree: true });
    }
    function fixTree(node) {
      if (!node || node.nodeType !== 1) return;
      var list = [node].concat(Array.prototype.slice.call(node.querySelectorAll("*")));
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        var attrs = URL_ATTRS[el.tagName];
        if (!attrs) continue;
        for (var k = 0; k < attrs.length; k++) {
          var v = el.getAttribute(attrs[k]);
          if (!v || /^(blob:|data:)/i.test(v)) continue;
          var m = null;
          try { m = mapElementAttr(vfs, el, attrs[k], v, pageBase()); } catch (e) {}
          if (m) setAttr.call(el, attrs[k], m);
        }
      }
    }
  }

  function render(win, vfs, path, shimSrc) {
    var bytes = vfs.files.get(path);
    if (!bytes) {
      win.document.body.textContent = "This app has no " + path;
      return false;
    }
    var html = new TextDecoder().decode(bytes);
    var doc = new win.DOMParser().parseFromString(html, "text/html");
    var base = win.location.href;
    rewriteDocument(vfs, doc, base);
    var shim = doc.createElement("script");
    shim.textContent = shimSrc;
    doc.head.insertBefore(shim, doc.head.firstChild);
    var doctype = doc.doctype ? "<!DOCTYPE " + doc.doctype.name + ">" : "<!DOCTYPE html>";
    win.document.open();
    win.document.write(doctype + doc.documentElement.outerHTML);
    win.document.close();
    return true;
  }

  function fail(win, text) {
    try { win.document.body.textContent = text; } catch (e) {}
  }

  function boot(win) {
    // Defense in depth: only ever run inside an opaque-origin child frame.
    // Served same-origin (no SW, misconfigured host), the app could read the
    // PWA's storage — refuse instead.
    if (win.origin !== "null" || win.parent === win) {
      fail(win, "Refusing to start: webxdc apps only run in Velta's sandboxed frame.");
      return;
    }
    var m = /^(.*\/webxdc-run\/\d+\/\d+\/)(.*)$/.exec(win.location.pathname);
    if (!m) { fail(win, "Bad webxdc URL"); return; }
    var scopePath = m[1].replace(/webxdc-run\/\d+\/\d+\/$/, "");
    var path = normPath(decodeURIComponent(m[2])) || "index.html";
    var shimSrc = win.__VELTA_SHIM_SRC || "";
    var id = "velta-bundle-" + Math.random().toString(36).slice(2);
    var onMsg = function (ev) {
      if (ev.source !== win.parent) return;
      var d = ev.data || {};
      if (d.type !== "velta-webxdc-response" || d.id !== id) return;
      win.removeEventListener("message", onMsg);
      if (d.error || !d.result || !d.result.xdc) { fail(win, "Could not load the app: " + (d.error || "no archive")); return; }
      unzip(d.result.xdc, inflateRawStream).then(function (files) {
        var vfs = createVfs(files, {
          origin: win.location.origin, appBasePath: m[1], scopePath: scopePath,
          createObjectURL: function (b) { return win.URL.createObjectURL(b); },
        });
        installRuntime(win, vfs);
        render(win, vfs, path, shimSrc);
      }).catch(function (e) { fail(win, "Could not open the app: " + (e && e.message || e)); });
    };
    win.addEventListener("message", onMsg);
    win.parent.postMessage({ type: "velta-webxdc-call", id: id, method: "veltaBundle", params: {} }, "*");
  }

  var api = { normPath: normPath, unzip: unzip, createVfs: createVfs, rewriteDocument: rewriteDocument,
    mapSrcset: mapSrcset, mimeFor: mimeFor, installRuntime: installRuntime, render: render, boot: boot };
  globalThis.VeltaWebxdcFrame = api;
  if (!globalThis.__VELTA_FRAME_NO_BOOT) boot(window);
})();
