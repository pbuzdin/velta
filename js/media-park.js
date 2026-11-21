// Off-screen rows stay in the chat LRU, but a live <video>/<audio> keeps a
// decoder. WebView2 stalls input once enough of those pile up, and chat
// clicks stop landing. park while detached; unpark when the row is shown.
// ponytail: one src slot on the element. A second pipeline per row (gallery
// posters) is a different tree — park that if it stalls too.

function mediaNodes(root) {
  if (!root?.querySelectorAll) return [];
  const out = [];
  for (const sel of ["video", "audio"]) {
    try { for (const n of root.querySelectorAll(sel)) out.push(n); } catch { /* fake DOM */ }
  }
  return out;
}

export function parkMedia(root) {
  for (const m of mediaNodes(root)) {
    const src = m.getAttribute?.("src");
    if (!src) continue;
    m.dataset.parkedSrc = src;
    try { m.pause?.(); } catch { /* not playing */ }
    m.removeAttribute?.("src");
    try { m.src = ""; } catch { /* property unsettable */ }
    try { m.load?.(); } catch { /* element already gone */ }
  }
}

export function unparkMedia(root) {
  for (const m of mediaNodes(root)) {
    const src = m.dataset?.parkedSrc;
    if (!src) continue;
    delete m.dataset.parkedSrc;
    if (m.getAttribute?.("src")) continue;
    try { m.src = src; } catch { m.setAttribute?.("src", src); }
  }
}
