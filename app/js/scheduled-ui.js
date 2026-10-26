// Scheduled messages UI: "Send later" sheet (presets + datetime-local),
// the per-chat list and the global list. Logic lives in scheduled.js.
import { showModal, confirmModal, toast } from "./ui.js";
import { escapeHtml } from "./components.js";
import { ICON } from "./icons.js";
import { t, currentLang } from "./i18n.js";
import { PRESETS, presetTime, toLocalInput, fromLocalInput, itemsFor } from "./scheduled.js";

const PRESET_LABEL = { hour: "In 1 hour", tonight: "Tonight", tomorrow: "Tomorrow morning", monday: "Monday morning" };

const fmtCache = new Map();
function fmt(ms, withDay = true) {
  const key = currentLang() + withDay;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(currentLang(), withDay
      ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" });
    fmtCache.set(key, f);
  }
  return f.format(new Date(ms));
}
export const formatDue = ms => fmt(ms, true);

function tzName() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
}

/** "Send later" sheet. Resolves the chosen UTC ms, or null. `initial`
 *  pre-fills the picker (Edit time). `browserOnly` adds the PWA note. */
export function pickSendTime({ title = "Send later", initial = null, browserOnly = false, now = Date.now() } = {}) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const body = document.createElement("div");
    body.className = "sched-pick";
    const presets = PRESETS.map(k => [k, presetTime(k, now)]).filter(([, v]) => v != null);
    const minVal = toLocalInput(now + 60_000);
    const startVal = toLocalInput(initial && initial > now ? initial : (presets[0]?.[1] ?? now + 3_600_000));
    body.innerHTML = `
      <div class="sched-presets" role="group" aria-label="${escapeHtml(t("Quick choices"))}">
        ${presets.map(([k, v]) => `<button type="button" class="ctx-item sched-preset" data-at="${v}">${ICON.clock}<span class="sched-preset-l">${escapeHtml(t(PRESET_LABEL[k]))}</span><span class="sched-preset-t">${escapeHtml(fmt(v, k !== "hour"))}</span></button>`).join("")}
      </div>
      <label class="sched-custom-l" for="sched-dt">${escapeHtml(t("Pick date and time"))}</label>
      <input id="sched-dt" class="sched-dt" type="datetime-local" min="${minVal}" value="${startVal}" required>
      <p class="sched-hint">${escapeHtml(t("Your time zone: {tz}", { tz: tzName() }))}</p>
      ${browserOnly ? `<p class="sched-hint">${escapeHtml(t("In the browser, scheduled messages are sent only while Velta is open."))}</p>` : ""}
      <p class="sched-err" role="alert" hidden></p>`;
    const foot = document.createElement("div");
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "btn-text"; cancel.textContent = t("Cancel");
    const ok = document.createElement("button");
    ok.type = "submit"; ok.className = "btn-text"; ok.textContent = t("Schedule");
    foot.append(cancel, ok);
    const { close, form } = showModal({ title, body, foot, compact: true, form: true, onClose: () => finish(null) });
    const input = body.querySelector("#sched-dt");
    const err = body.querySelector(".sched-err");
    for (const b of body.querySelectorAll(".sched-preset")) {
      b.addEventListener("click", () => { finish(Number(b.dataset.at)); close(); });
    }
    cancel.addEventListener("click", close);
    form.addEventListener("submit", () => {
      const at = fromLocalInput(input.value);
      if (at == null || at <= Date.now()) {
        err.textContent = t("Pick a time in the future");
        err.hidden = false;
        input.focus();
        return;
      }
      finish(at);
      close();
    });
    (initial ? input : body.querySelector(".sched-preset") || input).focus();
  });
}

function editText(item) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const body = document.createElement("div");
    body.innerHTML = `<label class="sched-custom-l" for="sched-text">${escapeHtml(t("Message"))}</label><textarea id="sched-text" class="sched-text" rows="5"></textarea>`;
    const ta = body.querySelector("textarea");
    ta.value = item.text;
    const foot = document.createElement("div");
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "btn-text"; cancel.textContent = t("Cancel");
    const ok = document.createElement("button");
    ok.type = "button"; ok.className = "btn-text"; ok.textContent = t("Save");
    foot.append(cancel, ok);
    const { close } = showModal({ title: "Edit scheduled message", body, foot, compact: true, onClose: () => finish(null) });
    cancel.addEventListener("click", close);
    ok.addEventListener("click", () => { const v = ta.value.trim(); if (v) { finish(v); close(); } });
    ta.focus();
  });
}

function statusLine(it) {
  if (it.status === "sending") return t("Sending…");
  if (it.status === "error") {
    return it.uncertain
      ? t("Not sure it was sent: {error}", { error: it.error || "" })
      : t("Failed, will retry: {error}", { error: it.error || "" });
  }
  return t("Scheduled for {time}", { time: formatDue(it.dueAt) });
}

/** Render the list into `root`. Exported for tests. */
export function renderScheduledList(root, items, { chatName = null } = {}) {
  if (!items.length) {
    root.innerHTML = `<p class="sched-empty">${escapeHtml(t("No scheduled messages"))}</p>`;
    return;
  }
  root.innerHTML = `<ul class="sched-list">${items.map(it => `
    <li class="sched-row${it.status === "error" ? " sched-row-err" : ""}" data-id="${escapeHtml(it.id)}">
      ${chatName ? `<div class="sched-chat">${escapeHtml(chatName(it) || "")}</div>` : ""}
      <div class="sched-when">${ICON.clock}<span>${escapeHtml(statusLine(it))}</span></div>
      <div class="sched-body">${escapeHtml(it.text)}</div>
      <div class="sched-acts">
        <button type="button" class="btn-text" data-act="now"${it.status === "sending" ? " disabled" : ""}>${escapeHtml(t("Send now"))}</button>
        <button type="button" class="btn-text" data-act="time"${it.status === "sending" ? " disabled" : ""}>${escapeHtml(t("Edit time"))}</button>
        <button type="button" class="btn-text" data-act="text"${it.status === "sending" ? " disabled" : ""}>${escapeHtml(t("Edit text"))}</button>
        <button type="button" class="btn-text sched-del" data-act="del"${it.status === "sending" ? " disabled" : ""}>${escapeHtml(t("Delete"))}</button>
      </div>
    </li>`).join("")}</ul>`;
}

/** Per-chat (accountId + chatId) or global (chatId null) list modal. */
export function openScheduledList({ runner, accountId, chatId = null, chatName = null, browserOnly = false, title = "Scheduled messages" }) {
  const body = document.createElement("div");
  body.className = "sched-sheet";
  const list = document.createElement("div");
  body.append(list);
  if (browserOnly) {
    const p = document.createElement("p");
    p.className = "sched-hint";
    p.textContent = t("In the browser, scheduled messages are sent only while Velta is open.");
    body.append(p);
  }
  const draw = () => renderScheduledList(list, itemsFor(runner.doc, accountId, chatId), { chatName: chatId == null ? chatName : null });
  let open = true;
  const prev = runner.onChange;
  runner.onChange = doc => { prev(doc); if (open) draw(); };
  showModal({ title, body, onClose: () => { open = false; runner.onChange = prev; } });
  draw();
  list.addEventListener("click", async e => {
    const btn = e.target.closest("button[data-act]");
    const id = btn?.closest("[data-id]")?.dataset.id;
    const it = id && runner.doc.items.find(x => x.id === id);
    if (!it) return;
    const act = btn.dataset.act;
    if (act === "now") {
      if (await runner.op({ op: "update", id, dueAt: Date.now() })) runner.run(true);
    } else if (act === "time") {
      const at = await pickSendTime({ title: "Edit time", initial: it.dueAt, browserOnly });
      if (at != null && !(await runner.op({ op: "update", id, dueAt: at }))) toast(t("Can't change it while it is being sent"));
    } else if (act === "text") {
      const v = await editText(it);
      if (v != null && !(await runner.op({ op: "update", id, text: v }))) toast(t("Can't change it while it is being sent"));
    } else if (act === "del") {
      if (await confirmModal("Delete scheduled message?", "It will not be sent.", "Delete")) {
        if (!(await runner.op({ op: "remove", id }))) toast(t("Can't change it while it is being sent"));
      }
    }
    // A nested modal replaced this one; reopen the list when it closed.
    if ((act === "time" || act === "text" || act === "del") && !open) {
      openScheduledList({ runner, accountId, chatId, chatName, browserOnly, title });
    }
  });
}

/** One-time Android prompt: exact alarms are optional. */
export async function maybeAskExactAlarm(invoke, storage = globalThis.localStorage) {
  const KEY = "velta-sched-exact-asked";
  try {
    if (storage.getItem(KEY)) return;
    const st = await invoke("scheduled_exact_status");
    if (st?.exact) return;
    storage.setItem(KEY, "1");
  } catch { return; }
  const body = `<p class="sched-hint" style="font-size:15px">${escapeHtml(t("Optional: allow “Alarms & reminders” so scheduled messages go out on time. Without it, Android may send them about 10–15 minutes late while the phone is idle."))}</p>`;
  const foot = document.createElement("div");
  const later = document.createElement("button");
  later.type = "button"; later.className = "btn-text"; later.textContent = t("Not now");
  const open = document.createElement("button");
  open.type = "button"; open.className = "btn-text"; open.textContent = t("Open settings");
  foot.append(later, open);
  const { close } = showModal({ title: "Exact timing", body, foot, compact: true });
  later.addEventListener("click", close);
  open.addEventListener("click", () => { close(); invoke("scheduled_exact_request").catch(() => {}); });
}
