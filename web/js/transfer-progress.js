// Profile export / second-device transfer / import progress (core
// ImexProgress, 0..1000 permille). One tracker per running job renders a
// native <progress> + percentage + stage line into its dialog, a small
// persistent pill when the dialog was closed (the transfer keeps running,
// c9695708), and — on Android — an ongoing notification with a progress bar.
// Byte sizes: the core reports only permille, so sizes are shown only when
// a caller passes `total` (bytes); the core paths never do today.
import { t } from "./i18n.js";
import { escapeHtml as esc } from "./format.js";
import { svg } from "./icons.js";

export const STAGES = {
  preparing: "Preparing…",
  waiting: "Waiting for the other device…",
  sending: "Sending…",
  receiving: "Receiving…",
  exporting: "Exporting…",
  saving: "Saving…",
  importing: "Importing…",
  done: "Done",
  failed: "Failed",
};

const TITLES = { send: "Sending profile", receive: "Receiving profile", export: "Exporting backup", import: "Importing backup" };

// Stage implied by a permille for a job kind (before/without stage overrides).
export function stageFor(kind, permille, seen) {
  if (permille >= 1000) return "done";
  if (permille > 0) return { send: "sending", receive: "receiving", export: "exporting", import: "importing" }[kind] || "sending";
  if (seen) return "failed";
  return kind === "send" ? "waiting" : "preparing";
}

export function formatBytes(n) {
  if (!(n >= 0)) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(n < 10 ? 1 : 0) : Math.round(n)} ${u[i]}`;
}

// Pure view model, tested in tests/transfer-progress.test.mjs.
export function progressModel({ kind, stage, permille = 0, total = null, error = "" }) {
  const p = Math.max(0, Math.min(1000, permille | 0));
  const pct = stage === "done" ? 100 : Math.floor(p / 10);
  const indeterminate = stage === "preparing" || stage === "waiting" || stage === "saving";
  let size = "";
  if (total > 0 && !indeterminate) size = `${formatBytes(Math.round(total * p / 1000))} / ${formatBytes(total)}`;
  let text = t(STAGES[stage] || stage);
  if (stage === "failed" && error) text = `${t("Failed")}: ${error}`;
  return { title: t(TITLES[kind] || "Transfer"), stage, text, pct, value: stage === "done" ? 1000 : p, indeterminate, size };
}

export function progressHtml(m) {
  const bar = m.indeterminate
    ? `<progress class="xfer-bar" aria-label="${esc(m.title)}"></progress>`
    : `<progress class="xfer-bar" max="1000" value="${m.value}" aria-label="${esc(m.title)}" aria-valuetext="${esc(`${m.pct}% — ${m.text}`)}"></progress>`;
  const pct = m.indeterminate ? "" : `<span class="xfer-pct">${m.pct}%</span>`;
  const size = m.size ? `<span class="xfer-size">${esc(m.size)}</span>` : "";
  return `<div class="xfer ${m.stage === "failed" ? "is-failed" : m.stage === "done" ? "is-done" : ""}" role="status" aria-live="polite">
  ${bar}
  <div class="xfer-row"><span class="xfer-stage">${esc(m.text)}</span>${size}${pct}</div>
</div>`;
}

const ICON = svg('<path d="M7 7h11l-3-3"/><path d="M17 17H6l3 3"/>', "", 'width="16" height="16"');

let pill = null;
function pillEl() {
  if (pill?.isConnected) return pill;
  pill = document.createElement("button");
  pill.type = "button";
  pill.className = "xfer-pill";
  pill.hidden = true;
  document.body.appendChild(pill);
  return pill;
}

// tracker = createTransferTracker({ core, kind, invoke })
//   .attach(el)       render into a dialog element (re-attach after reopen)
//   .set({stage, error, total})  override stage (e.g. "waiting", "saving")
//   .finish(ok, error) terminal state; pill/notification clear after a delay
export function createTransferTracker({ core, kind, invoke = null, onPillClick = null }) {
  const st = { kind, stage: kind === "send" ? "preparing" : "preparing", permille: 0, total: null, error: "", seen: false, ended: false };
  let host = null;
  let lastNotified = null;
  const notify = (m) => {
    if (!invoke) return;
    const step = st.ended ? "end" : m.indeterminate ? `ind:${m.stage}` : m.pct;
    if (step === lastNotified) return;
    lastNotified = step;
    invoke("transfer_notify", { permille: st.ended ? -1 : (m.indeterminate ? -2 : m.value), title: m.title, text: m.text })?.catch?.(() => {});
  };
  const render = () => {
    const m = progressModel(st);
    if (host?.isConnected) host.innerHTML = progressHtml(m);
    const p = typeof document !== "undefined" ? pillEl() : null;
    if (p) {
      const show = !st.ended && !host?.isConnected;
      p.hidden = !show;
      if (show) {
        p.innerHTML = `${ICON}<span>${esc(m.title)}${m.indeterminate ? "" : ` ${m.pct}%`}</span>`;
        p.setAttribute("aria-label", `${m.title}: ${m.text}${m.indeterminate ? "" : ` ${m.pct}%`}`);
        p.onclick = () => onPillClick?.();
      }
    }
    notify(m);
  };
  const onProg = (e) => {
    if (st.ended) return;
    const p = e.detail?.progress || 0;
    if (p >= 1000) return api.finish(true);
    if (p > 0) { st.seen = true; st.permille = p; st.stage = stageFor(kind, p, true); render(); }
    else if (st.seen) api.finish(false, st.error);
  };
  core?.addEventListener?.("imex-progress", onProg);
  const api = {
    state: st,
    attach(el) { host = el; render(); return api; },
    set(patch) { if (!st.ended) { Object.assign(st, patch); render(); } return api; },
    finish(ok, error = "") {
      if (st.ended) return api;
      st.stage = ok ? "done" : "failed";
      if (ok) st.permille = 1000;
      st.error = error ? String(error) : "";
      core?.removeEventListener?.("imex-progress", onProg);
      // Keep the terminal line in the dialog; drop pill + notification.
      const m = progressModel(st);
      if (host?.isConnected) host.innerHTML = progressHtml(m);
      st.ended = true;
      if (pill) pill.hidden = true;
      notify(m);
      return api;
    },
  };
  return api;
}
