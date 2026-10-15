// UI glue for the "Send directly" webxdc app. Concatenated after
// transfer.js into main.js by tools/build-builtin-xdc.mjs.
(function () {
  const wx = window.webxdc;
  const $ = (s) => document.querySelector(s);
  const list = $("#list");
  const fmt = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let me = "";
  let channel = null;
  const senders = new Map();   // id -> Sender (files I offer, this session)
  const offers = new Map();    // id -> {offer, from, card, rx}
  let lastHeard = 0;

  function send(bytes) { try { channel && channel.send(bytes); } catch (e) { console.warn(e); } }

  function join() {
    if (channel || !wx.joinRealtimeChannel) return;
    try { channel = wx.joinRealtimeChannel(); } catch (e) { $("#peers").textContent = "Realtime channel unavailable: " + e.message; return; }
    channel.setListener((data) => {
      lastHeard = Date.now();
      const f = Transfer.decodeFrame(data);
      if (!f) return;
      if (f.type === Transfer.T_OFFER && Transfer.validOffer(f.header)) addOffer(f.header, "");
      else if (f.type === Transfer.T_REQ) { const s = senders.get(f.header.id); if (s) { s.handle(f); paintSender(f.header.id); } }
      else if (f.type === Transfer.T_CHUNK) { const o = offers.get(f.header.id); if (o && o.rx && o.rx.handle(f)) paintRx(o); }
    });
  }

  function addOffer(offer, from) {
    if (senders.has(offer.id)) return;
    let o = offers.get(offer.id);
    if (o) { o.live = Date.now(); paintRx(o); return; }
    o = { offer, from, rx: null, live: from ? 0 : Date.now(), card: document.createElement("div") };
    o.card.className = "card";
    offers.set(offer.id, o);
    list.prepend(o.card);
    paintRx(o);
  }

  function paintRx(o) {
    const { offer, rx } = o;
    const online = Date.now() - o.live < 8000;
    let state = online ? "Sender is online" : "Waiting for the sender to open this app…";
    if (rx && !rx.done) state = `Receiving ${fmt(rx.receivedBytes)} of ${fmt(offer.size)}`;
    if (rx && rx.done) state = rx.ok ? '<span class="ok">Received — SHA-256 verified</span>' : '<span class="bad">Checksum mismatch — file discarded</span>';
    o.card.innerHTML = `<div class="name">${esc(offer.name)}</div>
      <div class="meta">${fmt(offer.size)}${o.from ? " · from " + esc(o.from) : ""}</div>
      <div class="meta" data-state>${state}</div>
      ${rx && !rx.done ? `<progress max="1000" value="${Math.round(rx.progress * 1000)}"></progress>` : ""}
      <div class="row" data-actions></div>`;
    const act = o.card.querySelector("[data-actions]");
    if (!rx) {
      const b = Object.assign(document.createElement("button"), { textContent: "Receive" });
      b.disabled = !online;
      b.onclick = () => { o.rx = new Transfer.Receiver({ offer, send }); o.rx.pump(); paintRx(o); };
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

  function paintSender(id) {
    const s = senders.get(id);
    if (!s || !s.card) return;
    s.card.querySelector("[data-state]").textContent = s.served ? `Sending… ${s.served} chunk(s) served` : "Waiting for receivers…";
  }

  $("#pick").onclick = async () => {
    join();
    let files;
    try { files = await wx.importFiles({ multiple: false }); } catch (e) { alert(e.message); return; }
    const file = files && files[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const s = new Transfer.Sender({ name: file.name || "file", bytes, send });
    senders.set(s.offer.id, s);
    s.card = document.createElement("div");
    s.card.className = "card";
    s.card.innerHTML = `<div class="name">${esc(s.offer.name)}</div><div class="meta">${fmt(s.offer.size)} · you are offering this</div><div class="meta" data-state>Waiting for receivers…</div><div class="meta">Keep this app open until they have it.</div>`;
    list.prepend(s.card);
    s.announce();
    // Status update: chat info line + receivers who open the app later see it.
    wx.sendUpdate({ payload: { offer: s.offer, from: me }, info: `Offering ${s.offer.name} (${fmt(s.offer.size)}) — open "Send directly" to receive` }, "");
  };

  setInterval(() => {
    for (const s of senders.values()) s.announce();
    for (const o of offers.values()) {
      if (o.rx && !o.rx.done) o.rx.pump();
      else if (!o.rx) paintRx(o);
    }
    $("#peers").textContent = lastHeard && Date.now() - lastHeard < 8000 ? "A peer is connected" : "";
  }, 2500);
  setInterval(() => { for (const o of offers.values()) if (o.rx && !o.rx.done) o.rx.pump(); }, 400);

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
