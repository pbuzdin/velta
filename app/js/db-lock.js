// #178, page side: the PWA snapshot is encrypted at rest with a DEK the
// worker holds only wrapped (dbkey.wrap + non-secret dbkey.meta at the OPFS
// root; phase 4 adds dbkey.pin / dbkey.recovery — the SAME DEK wrapped under
// an app-lock PIN / a recovery code). WebAuthn lives on the page, not in
// workers, so this module probes the lock BEFORE the core transport exists,
// collects the passphrase / PIN / recovery code or evaluates the passkey PRF
// (a user gesture is required anyway), derives the KEK (db-crypt.js) and
// hands the bytes to createCore with the wrap the worker must unwrap. The
// KEK is never stored; wrong input just fails the GCM unwrap — nothing is
// ever reset.
import { deriveKekPassphrase, deriveKekPrf, prfEval, prfSupported, unb64, unwrapDek } from "./db-crypt.js";
import { t } from "./i18n.js";

// A wrap's bytes + KDF params, or null. Some fake-OPFS harnesses auto-create
// handles, so an EMPTY file means absent.
async function readWrap(root, file, metaFile) {
  try {
    const wrap = await (await root.getFileHandle(file)).getFile();
    if (!wrap.size) return null;
    const wrapBytes = new Uint8Array(await wrap.arrayBuffer());
    let meta = {};
    try { meta = JSON.parse((await (await root.getFileHandle(metaFile)).getFile()).text() || "{}"); } catch {}
    return { wrapBytes, salt: String(meta.salt || ""), iter: Number(meta.iter) || 600_000 };
  } catch {
    return null;
  }
}

export async function probeLock() {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return null;
    const main = await readWrap(root, "dbkey.wrap", "dbkey.meta");
    if (!main) return null;
    let meta = {};
    try { meta = JSON.parse((await (await root.getFileHandle("dbkey.meta")).getFile()).text() || "{}"); } catch {}
    return {
      mode: meta.mode === "prf" ? "prf" : "pass",
      salt: main.salt,
      iter: main.iter,
      credId: String(meta.credId || ""),
      wrapBytes: main.wrapBytes,
      pin: await readWrap(root, "dbkey.pin", "dbkey.pinmeta"),
      recovery: await readWrap(root, "dbkey.recovery", "dbkey.recmeta"),
    };
  } catch {
    return null;
  }
}

// Blocking unlock surface, styled after #db-locked (main.css). Resolves with
// {kek, src} once the entered secret verified against its wrap — src names
// the wrap file the worker must unwrap ("wrap" | "pin" | "recovery"); the
// worker verifies again by unwrapping and answers boot-error on failure.
// Wrong attempts back off exponentially, in-session only: someone holding a
// copy of the profile files can brute-force offline regardless, so the PIN
// is a convenience unlock, not a stronger root.
export function unlockInteractive(info) {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.id = "db-locked";
    const prfMode = info.mode === "prf" && !!info.credId;
    // key → [button/input label, input placeholder, input kind]
    const methods = {
      ...(prfMode ? { prf: [t("Unlock with passkey"), "", ""] } : {}),
      ...(!prfMode ? { pass: [t("Unlock"), t("Passphrase"), "password"] } : {}),
      ...(info.pin ? { pin: [t("Unlock with PIN"), t("PIN"), "password"] } : {}),
      ...(info.recovery ? { recovery: [t("Unlock with recovery code"), t("Recovery code"), "text"] } : {}),
    };
    const switchLabel = { prf: t("Use the passkey"), pass: t("Use the passphrase"), pin: t("Use a PIN instead"), recovery: t("Use a recovery code instead") };
    let cur = prfMode ? "prf" : "pass";
    let fails = 0;
    box.innerHTML = `
      <div class="db-locked-card">
        <h2>${t("Unlock your data")}</h2>
        <p>${prfMode
          ? t("This profile's local data is encrypted. Use your passkey to unlock it. Nothing is reset on a wrong attempt.")
          : t("This profile's local data is encrypted. Enter your encryption passphrase to unlock it. Nothing is reset on a wrong attempt.")}</p>
        <div class="db-unlock-form"></div>
        <p class="db-locked-hint db-unlock-status" hidden></p>
        <p class="db-locked-hint db-unlock-switch"></p>
      </div>`;
    document.body.appendChild(box);
    const formBox = box.querySelector(".db-unlock-form");
    const status = box.querySelector(".db-unlock-status");
    const switchBox = box.querySelector(".db-unlock-switch");
    let go = null;
    let input = null;
    const fail = (msg) => {
      status.textContent = msg;
      status.hidden = false;
      // Exponential backoff (1s, 2s, … capped 30s) against quick retries.
      const wait = Math.min(30, 2 ** fails++);
      go.disabled = true;
      if (input) input.disabled = true;
      const tick = (left) => {
        if (left <= 0) { go.disabled = false; if (input) input.disabled = false; status.hidden = true; return; }
        status.textContent = `${msg} ${t("Wait {n} s.", { n: left })}`;
        setTimeout(() => tick(left - 1), 1000);
      };
      tick(wait);
    };
    const attempt = async () => {
      go.disabled = true;
      try {
        if (cur === "prf") {
          const kek = await deriveKekPrf(await prfEval(unb64(info.credId), unb64(info.salt)), unb64(info.salt));
          const dek = await unwrapDek(kek, info.wrapBytes);
          if (dek?.length !== 32) throw new Error("bad unwrap");
          box.remove();
          resolve({ kek, src: "wrap" });
          return;
        }
        const src = cur === "pass" ? "wrap" : cur;
        const wrapInfo = cur === "pass" ? info : info[cur];
        const raw = cur === "pin" ? input.value : cur === "recovery" ? input.value.toUpperCase().replace(/[^A-Z0-9]/g, "") : input.value;
        const kek = await deriveKekPassphrase(raw, unb64(wrapInfo.salt), wrapInfo.iter);
        // Verify here (GCM unwrap) so a wrong input stays on this screen —
        // the DEK bytes verify-and-discard; the worker re-derives its own.
        const dek = await unwrapDek(kek, wrapInfo.wrapBytes);
        if (dek?.length !== 32) throw new Error("bad unwrap");
        box.remove();
        resolve({ kek, src });
      } catch (err) {
        fail(cur === "prf"
          ? t("The passkey did not unlock this profile. Try again.")
          : cur === "pin"
            ? t("Wrong PIN. Try again — nothing was changed.")
            : cur === "recovery"
              ? t("Wrong recovery code. Try again — nothing was changed.")
              : t("Wrong passphrase. Try again — nothing was changed."));
      }
    };
    const render = () => {
      const [label, placeholder, kind] = methods[cur];
      if (cur === "prf") {
        formBox.innerHTML = `<button class="btn-primary db-unlock-go" type="button">${label}</button>`;
      } else {
        formBox.innerHTML = `<form>
          <input class="text-field db-unlock-pass" type="${kind}" required ${kind === "password" ? 'autocomplete="current-password"' : 'autocomplete="off" autocapitalize="characters" spellcheck="false"'} placeholder="${placeholder}">
          <button class="btn-primary db-unlock-go" type="submit">${label}</button>
        </form>`;
        formBox.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); attempt(); });
      }
      go = formBox.querySelector(".db-unlock-go");
      input = formBox.querySelector(".db-unlock-pass");
      input?.focus();
      switchBox.innerHTML = Object.keys(methods).filter((k) => k !== cur)
        .map((k) => `<button type="button" class="btn-text db-unlock-alt" data-alt="${k}">${switchLabel[k]}</button>`).join(" ");
      switchBox.querySelectorAll("[data-alt]").forEach((b) => b.addEventListener("click", () => { cur = b.dataset.alt; status.hidden = true; fails = 0; render(); }));
    };
    render();
  });
}

// Settings-row helper: true when a WebAuthn PRF passkey can be offered.
export { prfSupported };
