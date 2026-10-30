// #178 phase 3, page side: the PWA snapshot is encrypted at rest with a DEK
// the worker holds only wrapped (dbkey.wrap + non-secret dbkey.meta at the
// OPFS root). WebAuthn lives on the page, not in workers, so this module
// probes the lock BEFORE the core transport exists, collects the passphrase
// or evaluates the passkey PRF (a user gesture is required anyway), derives
// the KEK (db-crypt.js) and hands the bytes to createCore. The KEK is never
// stored; wrong input just fails the GCM unwrap — nothing is ever reset.
import { deriveKekPassphrase, deriveKekPrf, prfEval, prfSupported, unb64, unwrapDek } from "./db-crypt.js";
import { t } from "./i18n.js";

export async function probeLock() {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return null;
    let wrap = null;
    try { wrap = await (await root.getFileHandle("dbkey.wrap")).getFile(); } catch { return null; }
    if (!wrap.size) return null;
    const wrapBytes = new Uint8Array(await wrap.arrayBuffer());
    let meta = {};
    try { meta = JSON.parse((await (await root.getFileHandle("dbkey.meta")).getFile()).text() || "{}"); } catch {}
    return {
      mode: meta.mode === "prf" ? "prf" : "pass",
      salt: String(meta.salt || ""),
      iter: Number(meta.iter) || 600_000,
      credId: String(meta.credId || ""),
      wrapBytes,
    };
  } catch {
    return null;
  }
}

// Blocking unlock surface, styled after #db-locked (main.css). Resolves
// with the KEK bytes once a correct passphrase/passkey was entered — the
// worker verifies by unwrapping and answers boot-error on failure.
export function unlockInteractive(info) {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.id = "db-locked";
    const prfMode = info.mode === "prf" && info.credId;
    box.innerHTML = `
      <div class="db-locked-card">
        <h2>${t("Unlock your data")}</h2>
        <p>${prfMode
          ? t("This profile's local data is encrypted. Use your passkey to unlock it. Nothing is reset on a wrong attempt.")
          : t("This profile's local data is encrypted. Enter your encryption passphrase to unlock it. Nothing is reset on a wrong attempt.")}</p>
        ${prfMode
          ? `<button class="btn-primary db-unlock-go" type="button">${t("Unlock with passkey")}</button>`
          : `<form class="db-unlock-form">
              <input class="text-field db-unlock-pass" type="password" required autocomplete="current-password" placeholder="${t("Passphrase")}">
              <button class="btn-primary db-unlock-go" type="submit">${t("Unlock")}</button>
            </form>`}
        <p class="db-locked-hint db-unlock-status" hidden></p>
      </div>`;
    document.body.appendChild(box);
    const status = box.querySelector(".db-unlock-status");
    const go = box.querySelector(".db-unlock-go");
    const pass = box.querySelector(".db-unlock-pass");
    const salt = unb64(info.salt);
    const fail = (msg) => {
      status.textContent = msg;
      status.hidden = false;
      go.disabled = false;
    };
    const attempt = async () => {
      go.disabled = true;
      try {
        const kek = prfMode
          ? await deriveKekPrf(await prfEval(unb64(info.credId), salt), salt)
          : await deriveKekPassphrase(pass.value, salt, info.iter);
        // Verify here (GCM unwrap) so a wrong input stays on this screen —
        // the DEK bytes verify-and-discard; the worker re-derives its own.
        const dek = await unwrapDek(kek, info.wrapBytes);
        if (dek?.length !== 32) throw new Error("bad unwrap");
        box.remove();
        resolve(kek);
      } catch (err) {
        fail(prfMode
          ? t("The passkey did not unlock this profile. Try again.")
          : t("Wrong passphrase. Try again — nothing was changed."));
      }
    };
    if (prfMode) go.addEventListener("click", attempt);
    else box.querySelector(".db-unlock-form").addEventListener("submit", (e) => { e.preventDefault(); attempt(); });
    pass?.focus();
  });
}

// Settings-row helper: true when a WebAuthn PRF passkey can be offered.
export { prfSupported };
