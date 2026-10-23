// UI glue for the "Velta Beam" (formerly "Send directly") webxdc app. Concatenated after
// transfer.js into main.js by tools/build-builtin-xdc.mjs.
(function () {
  const wx = window.webxdc;
  const $ = (s) => document.querySelector(s);
  const list = $("#list");
  // Velta's webxdc shim always adds webxdc.veltaCall (an object, even for
  // untrusted apps); Delta Chat and other hosts don't. Outside Velta show one
  // quiet line pointing to Velta.
  const inVelta = !!(wx && typeof wx.veltaCall === "object" && wx.veltaCall);
  if (!inVelta) $("#velta-cta").hidden = false;
  const fmt = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let me = "";
  const sessionPeer = "anon-" + Math.random().toString(16).slice(2, 10);
  const myName = () => String(wx.selfName || me || wx.selfAddr || "");
  const myPeer = () => String(wx.selfAddr || me || sessionPeer);
  const trackers = new Map(); // offer id -> ReceiverTracker (sender and receivers)
  const tracker = (id) => { let t = trackers.get(id); if (!t) trackers.set(id, t = new Transfer.ReceiverTracker({ id })); return t; };
  let channel = null;
  const senders = new Map();   // id -> Sender (files I offer, this session)
  const offers = new Map();    // id -> {offer, from, card, rx, seed, live}
  const LIVE_MS = 8000;        // a holder heard within this is "online"
  let lastHeard = 0;
  // Velta web app (PWA): no realtime channels until iroh runs in wasm. Show
  // that plainly instead of a channel that never connects; offers from
  // status updates still list, but cannot be sent or received here.
  const NO_RT = "Direct transfer is not available in the Velta web app yet. Open this chat in Velta for desktop or Android to send or receive.";
  let noRealtime = false;
  function markNoRealtime() {
    noRealtime = true;
    const b = $("#pick");
    b.disabled = true;
    b.title = NO_RT;
    $("#peers").textContent = NO_RT;
    for (const o of offers.values()) paintRx(o);
  }

  function send(bytes) { try { channel && channel.send(bytes); } catch (e) { console.warn(e); } }

  function join() {
    if (noRealtime) return;
    if (wx.veltaRealtimeAvailable === false) { markNoRealtime(); return; }
    if (channel || !wx.joinRealtimeChannel) return;
    try { channel = wx.joinRealtimeChannel(); } catch (e) { $("#peers").textContent = "Realtime channel unavailable: " + e.message; return; }
    channel.setListener((data) => {
      lastHeard = Date.now();
      const f = Transfer.decodeFrame(data);
      if (!f) return;
      const id = f.header && f.header.id;
      if (f.type === Transfer.T_OFFER && Transfer.validOffer(f.header)) addOffer(f.header, "");
      else if (f.type === Transfer.T_REQ) {
        const s = senders.get(id); if (s) { s.handle(f); paintSender(id); }
        const o = offers.get(id); if (o && o.seed) o.seed.handle(f);
      }
      else if (f.type === Transfer.T_PROG) {
        if (f.header.peer === myPeer()) return;
        if (tracker(id).handle(f)) {
          const o = offers.get(id);
          if (o && f.header.seed) o.live = Date.now();
          if (senders.has(id)) paintSender(id); else paintPeers(o);
        }
      }
      else if (f.type === Transfer.T_CHUNK) {
        // Any piece on the air reached everyone: seeders drop their duplicate.
        const s = senders.get(id); if (s) s.noteChunk(f.header.i);
        const o = offers.get(id);
        if (!o) return;
        o.live = Date.now();
        if (o.seed) o.seed.noteChunk(f.header.i);
        if (o.rx && o.rx.handle(f)) { paintRx(o); if (o.rx.done) sendProgress(o); }
      }
    });
  }

  function addOffer(offer, from) {
    if (senders.has(offer.id)) return;
    let o = offers.get(offer.id);
    if (o) { o.live = Date.now(); if (!o.rx && o.shownOnline !== true) paintRx(o); return; }
    o = { offer, from, rx: null, live: from ? 0 : Date.now(), card: document.createElement("div") };
    o.card.className = "card";
    offers.set(offer.id, o);
    list.prepend(o.card);
    paintRx(o);
  }

  function paintRx(o) {
    const { offer, rx } = o;
    const online = Date.now() - o.live < LIVE_MS;
    o.shownOnline = online;
    let state = online ? "Available now" : "Waiting for someone who has it to open Beam…";
    if (rx && !rx.done) state = `Receiving ${fmt(rx.receivedBytes)} of ${fmt(offer.size)}` + (online ? "" : " · waiting for a sender");
    if (noRealtime && !rx) state = NO_RT;
    if (rx && rx.done) state = rx.ok ? '<span class="ok">Received — SHA-256 verified</span> · sharing while Beam is open' : '<span class="bad">Checksum mismatch — file discarded</span>';
    o.card.innerHTML = `<div class="name">${esc(offer.name)}</div>
      <div class="meta">${fmt(offer.size)}${o.from ? " · from " + esc(o.from) : ""}</div>
      <div class="meta" data-state>${state}</div>
      ${rx && !rx.done ? `<progress max="1000" value="${Math.round(rx.progress * 1000)}"></progress>` : ""}
      <div class="meta" data-seeders></div>
      <div class="row" data-actions></div>
      <div data-peers></div>`;
    paintPeers(o);
    const act = o.card.querySelector("[data-actions]");
    if (!rx) {
      const b = Object.assign(document.createElement("button"), { textContent: "Receive" });
      b.disabled = !online || noRealtime;
      b.onclick = () => {
        o.rx = new Transfer.Receiver({ offer, send });
        // Verified pieces (per-piece hashes) or the verified file are shared on.
        o.seed = new Transfer.Seeder({ offer, send, piece: (i) => o.rx.piece(i) });
        o.rx.pump(); sendProgress(o); paintRx(o);
      };
      act.append(b);
    } else if (rx.done && rx.ok) {
      const blob = () => new File([rx.bytes], offer.name);
      const save = Object.assign(document.createElement("button"), { textContent: "Save to chat" });
      save.onclick = async () => {
        try { const r = await wx.sendToChat({ file: { name: offer.name, blob: blob() } }); if (r && r.ok === false && !r.cancelled) alert(r.error || "Could not send"); } catch (e) { alert(e.message); }
      };
      const dl = Object.assign(document.createElement("button"), { textContent: "Download", className: "sec" });
      dl.onclick = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob()); a.download = offer.name; a.click(); };
      act.append(save, dl);
    }
  }

  function sendProgress(o) {
    if (o && o.rx) send(Transfer.progressFrame(o.rx, myPeer(), myName(), { seed: o.rx.canSeed }));
  }
  function sendPresence(s) {
    send(Transfer.progressFrame(null, myPeer(), myName(), { seed: true, src: true, n: s.offer.n, id: s.offer.id }));
  }

  // Receiver list (percent bar per receiver, "done" once SHA-256 verified).
  function peersHtml(id) {
    const t = trackers.get(id);
    const rows = t ? t.receivers() : [];
    if (!rows.length) return "";
    return `<ul class="peers" aria-label="Receivers">${rows.map((p) => {
      const st = p.done ? (p.ok ? '<span class="ok">done</span>' : '<span class="bad">checksum failed</span>') : p.stale ? `${p.percent}% · stale` : `${p.percent}%`;
      return `<li><span class="pn">${esc(p.name)}</span><progress max="100" value="${p.done ? 100 : p.percent}" aria-label="${esc(p.name)} ${p.percent}%"></progress><span class="ps">${st}</span></li>`;
    }).join("")}</ul>`;
  }
  function seedersText(id) {
    const t = trackers.get(id);
    const names = t ? t.seeders().map((p) => p.name) : [];
    if (!names.length) return "";
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
    return `Shared by ${shown}`;
  }
  function paintPeers(o) {
    if (!o || !o.card) return;
    const el = o.card.querySelector("[data-peers]");
    if (el) el.innerHTML = peersHtml(o.offer.id);
    const sd = o.card.querySelector("[data-seeders]");
    if (sd) { const tx = seedersText(o.offer.id); if (sd.textContent !== tx) sd.textContent = tx; }
  }

  function paintSender(id) {
    const s = senders.get(id);
    if (!s || !s.card) return;
    const t = trackers.get(id);
    const n = t ? t.activeCount() : 0;
    s.card.querySelector("[data-state]").textContent = n ? `${n} receiver${n === 1 ? "" : "s"}` + (s.served ? ` · ${s.served} chunk(s) served` : "") : s.served ? `Sending… ${s.served} chunk(s) served` : "Waiting for receivers…";
    s.card.querySelector("[data-peers]").innerHTML = peersHtml(id);
    const sd = s.card.querySelector("[data-seeders]");
    const tx = seedersText(id);
    if (sd.textContent !== tx) sd.textContent = tx;
  }

  $("#pick").onclick = async () => {
    join();
    if (noRealtime) return;
    let files;
    try { files = await wx.importFiles({ multiple: false }); } catch (e) { alert(e.message); return; }
    const file = files && files[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const s = new Transfer.Sender({ name: file.name || "file", bytes, send });
    senders.set(s.offer.id, s);
    s.card = document.createElement("div");
    s.card.className = "card";
    s.card.innerHTML = `<div class="name">${esc(s.offer.name)}</div><div class="meta">${fmt(s.offer.size)} · you are offering this</div><div class="meta" data-state>Waiting for receivers…</div><div class="meta">Keep Beam open until someone has it — then they pass it on too.</div><div class="meta" data-seeders></div><div data-peers></div>`;
    list.prepend(s.card);
    s.announce();
    // Status update: chat info line + receivers who open the app later see it.
    wx.sendUpdate({ payload: { offer: s.offer, from: me }, info: `Offering ${s.offer.name} (${fmt(s.offer.size)}) — open "Velta Beam" to receive` }, "");
  };

  setInterval(() => {
    for (const s of senders.values()) s.announce();
    // Seeders re-announce too (half the time, so a crowd doesn't echo), which
    // is how a late joiner sees "Available" after the sender left.
    for (const o of offers.values()) if (o.rx && o.rx.done && o.rx.ok && Math.random() < 0.5) o.seed.announce();
    for (const o of offers.values()) {
      if (o.rx && !o.rx.done) o.rx.pump();
      else if (!o.rx && o.shownOnline !== Date.now() - o.live < LIVE_MS) paintRx(o); // repaint on change only (keeps the button under the finger)
    }
    let n = 0;
    for (const t of trackers.values()) n += t.activeCount();
    const line = noRealtime ? NO_RT : n ? `${n} receiver${n === 1 ? "" : "s"}` : lastHeard && Date.now() - lastHeard < 8000 ? "A peer is connected" : "";
    if ($("#peers").textContent !== line) $("#peers").textContent = line; // aria-live: announce changes only
    for (const id of senders.keys()) paintSender(id);
    for (const o of offers.values()) paintPeers(o);
  }, 2500);
  setInterval(() => { for (const o of offers.values()) if (o.rx && !o.rx.done) o.rx.pump(); }, 400);
  // Jittered / rate-limited piece answers go out here.
  setInterval(() => {
    for (const s of senders.values()) s.flush();
    for (const o of offers.values()) if (o.seed) o.seed.flush();
  }, 100);
  // Progress every ~1 s while receiving, and keep announcing "done" while open
  // (the channel is lossy; the sender drops silent receivers after 10 s).
  setInterval(() => {
    for (const o of offers.values()) sendProgress(o);
    for (const s of senders.values()) sendPresence(s);
  }, Transfer.PROG_MS);

  (async () => {
    try { const i = await wx.getSelfInfo(); me = (i && i.addr) || ""; } catch (e) {}
    join();
    wx.setUpdateListener((u) => {
      const p = u && u.payload;
      if (p && p.offer && Transfer.validOffer(p.offer) && !senders.has(p.offer.id)) {
        if (p.from && p.from === me) return; // mine from an earlier session: the bytes are gone
        addOffer(p.offer, p.from || "");
      }
    }, 0);
  })();
})();
