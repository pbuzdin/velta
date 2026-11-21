// PWA websocket relays settings modal. Loaded on first open (app.js).
import { escapeHtml } from "./format.js";
import { t } from "./i18n.js";
import { activeWsRelay, addWsRelay, editWsRelay, listWsRelays, removeWsRelay, useWsRelay, wsProxyUrl } from "./ws-relays.js";

export async function showWsRelaysModal() {
  const { showModal, toast } = await import("./ui.js");
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="font-size:14.5px;line-height:1.5;margin-bottom:8px">${escapeHtml(t("Mail in this browser tunnels through the relay marked in use. Switching reloads the page."))}</p>
    <div class="modal-list" data-relay-list style="max-height:220px;overflow:auto"></div>
    <form data-relay-form style="display:flex;gap:8px;margin:10px 0 0">
      <input class="text-field" data-relay-input required placeholder="relay.example.org" autocomplete="off" inputmode="url" autocapitalize="none" spellcheck="false" style="flex:1">
      <button type="submit" class="btn-text" data-relay-save>${escapeHtml(t("Add"))}</button>
    </form>`;
  const listEl = body.querySelector("[data-relay-list]");
  const input = body.querySelector("[data-relay-input]");
  const saveBtn = body.querySelector("[data-relay-save]");
  let editing = null;

  const changed = (before, fn) => {
    const result = fn();
    if (result && wsProxyUrl() !== before) {
      toast(t("Relay changed, reloading"));
      setTimeout(() => location.reload(), 400);
    }
    return result;
  };

  const render = () => {
    listEl.replaceChildren();
    const active = activeWsRelay();
    for (const host of listWsRelays()) {
      const item = document.createElement("div");
      item.className = "info-row";
      item.innerHTML = `<span class="v">${escapeHtml(host)}${host === active ? ` <span style="opacity:.55">(${escapeHtml(t("in use"))})</span>` : ""}</span>`;
      const btn = (label, click) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn-text";
        b.textContent = label;
        b.addEventListener("click", click);
        item.appendChild(b);
      };
      if (host !== active) btn(t("Use"), () => changed(wsProxyUrl(), () => useWsRelay(host)));
      btn(t("Edit"), () => {
        editing = host;
        input.value = host;
        saveBtn.textContent = t("Save");
        input.focus();
      });
      if (listWsRelays().length > 1) {
        btn(t("Remove"), () => {
          changed(wsProxyUrl(), () => removeWsRelay(host));
          if (editing === host) { editing = null; saveBtn.textContent = t("Add"); input.value = ""; }
          render();
        });
      }
      listEl.appendChild(item);
    }
  };
  render();
  showModal({ title: "WebSocket relays", body });
  body.querySelector("[data-relay-form]").addEventListener("submit", (e) => {
    e.preventDefault();
    const before = wsProxyUrl();
    if (editing) {
      const from = editing;
      const next = editWsRelay(from, input.value);
      editing = null;
      saveBtn.textContent = t("Add");
      if (!next) { toast(t("Enter a different domain, e.g. relay.example.org")); return; }
      input.value = "";
      if (wsProxyUrl() !== before) {
        toast(t("Relay changed, reloading"));
        setTimeout(() => location.reload(), 400);
        return;
      }
      render();
      return;
    }
    const host = addWsRelay(input.value);
    if (!host) { toast(t("Enter a domain, e.g. relay.example.org")); return; }
    input.value = "";
    if (wsProxyUrl() !== before) {
      toast(t("Relay changed, reloading"));
      setTimeout(() => location.reload(), 400);
      return;
    }
    render();
    toast(t("{host} added", { host }));
  });
}
