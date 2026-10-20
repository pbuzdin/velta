// Velta Circle — UI only. Audio, the mic and the connections live in the
// Velta host (webxdc.veltaCall, docs/agents/group-calls.md); this app never
// touches WebRTC. In Delta Chat (no veltaCall) it shows "needs Velta" and the
// roster it can read from status updates.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var vc = window.webxdc && window.webxdc.veltaCall;
  // Same name-derived avatar color as the host (app/js/name-color.js
  // nameColor): hue from the name, lightness 55% unless the soft-white
  // initials would drop under 3:1 (large text), then darker.
  function hsl2rgb(h, s, l) { s /= 100; l /= 100; var a = s * Math.min(l, 1 - l); return [0, 8, 4].map(function (n) { var k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); }); }
  function lum(c) { return c.map(function (v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce(function (s, v, i) { return s + v * [0.2126, 0.7152, 0.0722][i]; }, 0); }
  function color(name) {
    var h = 0; name = String(name || "?"); for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    h %= 360; var l = 55, ink = lum([244, 244, 244]);
    while (l > 20 && (ink + 0.05) / (lum(hsl2rgb(h, 55, l)) + 0.05) < 3) l--;
    return "hsl(" + h + " 55% " + l + "%)";
  }
  // The host's live design tokens (theme + custom accent).
  function applyTheme(t) {
    if (!t || typeof t !== "object") return;
    for (var k in t) if (/^--[a-z0-9-]+$/.test(k) && typeof t[k] === "string" && t[k].length < 120) document.documentElement.style.setProperty(k, t[k]);
    if (t["color-scheme"] === "light" || t["color-scheme"] === "dark") document.documentElement.style.colorScheme = t["color-scheme"];
  }
  function initial(n) { n = String(n || "?").trim(); return (n[0] || "?").toUpperCase(); }

  // --- name + creator (the starter's "meta" status update) ------------------
  var meta = null;
  function readMeta(u) {
    var m = u && u.payload && u.payload.veltaCall;
    if (meta || !m || m.t !== "meta") return;
    meta = { title: String(m.title || "").trim().slice(0, 80) || "Group call", creator: String(m.creatorName || "").slice(0, 120) };
    $("title").textContent = meta.title;
    document.title = meta.title;
    $("creator").textContent = meta.creator ? "Started by " + meta.creator : "";
  }
  function listen(extra) {
    if (window.webxdc && window.webxdc.setUpdateListener) {
      return window.webxdc.setUpdateListener(function (u) { readMeta(u); if (extra) extra(u); }, 0);
    }
    return Promise.resolve();
  }

  // --- Delta Chat (or any client without Velta's call API) -----------------
  var roster = {};
  function readRoster(u) {
    var m = u && u.payload && u.payload.veltaCall;
    if (!m || typeof m.from !== "string" || m.t === "meta") return;
    var now = Date.now();
    if (m.t === "join" || m.t === "hb") roster[m.from] = { name: m.name || (roster[m.from] || {}).name || m.from, ts: m.ts || now };
    if (m.t === "leave") delete roster[m.from];
  }
  function showDcRoster() {
    var now = Date.now(), names = [];
    for (var k in roster) if (now - roster[k].ts < 240000) names.push(roster[k].name);
    $("dc-roster").textContent = names.length ? "In the call now: " + names.join(", ") + "." : "Nobody is in the call right now.";
  }

  function noVelta() {
    $("needs-velta").hidden = false;
    $("sub").textContent = "Velta Circle · Velta-only app";
    listen(function (u) { readRoster(u); if (u.serial === u.max_serial) showDcRoster(); }).then(showDcRoster);
  }

  // --- Velta ---------------------------------------------------------------
  function render(s) {
    var inCall = s && (s.state === "active" || s.state === "joining" || s.state === "full");
    $("join").hidden = inCall;
    $("mute").hidden = !inCall || s.state === "full";
    $("leave").hidden = !inCall;
    $("note").hidden = !(inCall && s.relayOnly);
    $("full").hidden = !(s && s.state === "full");
    if (s && s.max) $("max").textContent = s.max;
    $("error").hidden = !(s && s.error && s.state === "ended");
    if (s && s.error) $("error").textContent = "Could not join: " + s.error;
    $("mute").setAttribute("aria-pressed", String(!!(s && s.muted)));
    $("mute").textContent = s && s.muted ? "Unmute" : "Mute";
    var parts = (s && inCall && s.participants) || [];
    var n = s && s.inCall ? s.inCall : parts.length;
    $("sub").textContent = !s || !inCall ? (s && s.inCall ? s.inCall + " in call" : "Nobody is in the call") :
      s.state === "joining" ? "Connecting…" : n + " in call" + (s.waiting ? " · " + s.waiting + " waiting" : "");
    var g = $("grid");
    g.textContent = "";
    parts.forEach(function (p) {
      var t = document.createElement("div");
      t.className = "tile" + (p.speaking ? " speaking" : "") + (s.activeSpeaker === p.id ? " active" : "");
      t.setAttribute("role", "listitem");
      var av = document.createElement("div"); av.className = "av"; av.style.background = color(p.name || p.id); av.textContent = initial(p.name || p.id);
      var nm = document.createElement("div"); nm.className = "name"; nm.textContent = (p.name || p.id) + (p.self ? " (you)" : "");
      var st = document.createElement("div"); st.className = "st";
      st.textContent = p.self ? "" : p.state === "connected" ? (p.speaking ? "speaking" : "") : p.state === "failed" ? "connection lost" : "connecting…";
      t.append(av, nm, st);
      if (p.muted) { var mi = document.createElement("span"); mi.className = "mute-ic"; mi.textContent = "🔇"; mi.title = "muted"; t.append(mi); }
      t.setAttribute("aria-label", (p.name || p.id) + (p.self ? ", you" : "") + (p.muted ? ", muted" : "") + (p.speaking ? ", speaking" : ""));
      g.append(t);
    });
  }

  function velta() {
    listen();
    vc.onState(render);
    $("join").onclick = function () { $("join").disabled = true; vc.join().catch(function () {}).then(function () { $("join").disabled = false; }); };
    $("mute").onclick = function () { vc.setMuted($("mute").getAttribute("aria-pressed") !== "true"); };
    $("leave").onclick = function () { vc.leave(); };
    vc.getState().then(render);
  }

  if (!vc) return noVelta();
  vc.available().then(function (ok) { if (ok) { vc.getTheme && vc.getTheme().then(applyTheme, function () {}); velta(); } else noVelta(); }, noVelta);
})();
