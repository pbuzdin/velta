// Velta Group Call — UI only. Audio, the mic and the connections live in the
// Velta host (webxdc.veltaCall, docs/agents/group-calls.md); this app never
// touches WebRTC. In Delta Chat (no veltaCall) it shows "needs Velta" and the
// roster it can read from status updates.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var vc = window.webxdc && window.webxdc.veltaCall;
  var COLORS = ["#2e7d5b", "#3d6bfd", "#a347d1", "#d1477a", "#d17a2e", "#2e9bb5", "#7a8b2e"];
  function color(id) { var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return COLORS[h % COLORS.length]; }
  function initial(n) { n = String(n || "?").trim(); return (n[0] || "?").toUpperCase(); }

  // --- Delta Chat (or any client without Velta's call API) -----------------
  var roster = {};
  function readRoster(u) {
    var m = u && u.payload && u.payload.veltaCall;
    if (!m || typeof m.from !== "string") return;
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
    $("sub").textContent = "Velta-only app";
    if (window.webxdc && window.webxdc.setUpdateListener) {
      window.webxdc.setUpdateListener(function (u) { readRoster(u); if (u.serial === u.max_serial) showDcRoster(); }, 0).then(showDcRoster);
    }
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
      var av = document.createElement("div"); av.className = "av"; av.style.background = color(p.id); av.textContent = initial(p.name || p.id);
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
    vc.onState(render);
    $("join").onclick = function () { $("join").disabled = true; vc.join().catch(function () {}).then(function () { $("join").disabled = false; }); };
    $("mute").onclick = function () { vc.setMuted($("mute").getAttribute("aria-pressed") !== "true"); };
    $("leave").onclick = function () { vc.leave(); };
    vc.getState().then(render);
  }

  if (!vc) return noVelta();
  vc.available().then(function (ok) { if (ok) velta(); else noVelta(); }, noVelta);
})();
