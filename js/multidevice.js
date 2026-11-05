// Multi-device switch helpers (#117 follow-up). The switch renders ONLY the
// core's per-account `bcc_self` value; nothing here is a source of truth for
// it. What this module keeps is the LAST VALUE THE USER CHOSE (or, before the
// first choice, the last value Velta saw) per account, so a 0 -> 1 flip the
// user did not make can be noticed. Chatmail core 2.63 flips bcc_self on by
// itself when a backup is exported (core/src/imex.rs export_database), when
// "Add second device" prepares its transfer (core/src/imex/transfer.rs) and
// when a sync message arrives from another device (core/src/sync.rs). It
// emits no event for that (bcc_self is not a synced key), so Velta compares
// on drawer open, on app resume and when a backup/transfer finishes.
// Velta never reverts the flip on its own — it offers "Turn off again".

import { t } from "./i18n.js";

export const MD_CHOICE_KEY = "velta-bcc-self-choice";

// Retry schedule for a failed bcc_self read (ms); the last delay repeats.
export const MD_RETRY_DELAYS = [2000, 5000, 15000, 30000];

export const MD_HINT = "Off: messages are deleted from the relay after this device downloads them. Turn on if you use this profile on other devices.";

export const MD_REENABLED_NOTE = "Multi-device was turned back on by a backup export, Add second device, or a sync from another device. Messages now stay on the relay.";

export const DL_LIMIT_HINT = "Files above the limit are not downloaded automatically: tap them to download. Until then they stay on the relay (until the relay purges them, usually after about 7 days) and use relay storage.";

function readMap(storage) {
  try {
    const m = JSON.parse(storage?.getItem(MD_CHOICE_KEY) || "{}");
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

function writeMap(storage, m) {
  try { storage?.setItem(MD_CHOICE_KEY, JSON.stringify(m)); } catch { /* quota / private mode */ }
}

export function getChoice(storage, accountId) {
  if (accountId == null) return null;
  const rec = readMap(storage)[String(accountId)];
  return rec && (rec.choice === "0" || rec.choice === "1") ? rec : null;
}

// The user picked `on` (switch, "Turn off again" or "Keep on").
export function recordChoice(storage, accountId, on) {
  if (accountId == null) return;
  const m = readMap(storage);
  m[String(accountId)] = { choice: on ? "1" : "0" };
  writeMap(storage, m);
}

export function markNotified(storage, accountId) {
  const rec = getChoice(storage, accountId);
  if (!rec) return;
  const m = readMap(storage);
  m[String(accountId)] = { ...rec, notified: true };
  writeMap(storage, m);
}

// Forget a removed account's record.
export function forgetAccount(storage, accountId) {
  const m = readMap(storage);
  if (!(String(accountId) in m)) return;
  delete m[String(accountId)];
  writeMap(storage, m);
}

// Classifies a fresh core read. `coreValue` is get_config("bcc_self")
// ("0"/"1"/null). Returns the switch state plus whether the core turned it
// back on behind the user's back (`reenabled`) and whether that has not been
// announced yet (`notify`). With no record yet the observed value becomes
// the baseline (`seed`), so upgrades start detecting from now on.
export function classify(coreValue, record) {
  const on = coreValue === "1";
  if (!record) return { state: on ? "on" : "off", reenabled: false, notify: false, seed: true };
  const reenabled = on && record.choice === "0";
  return { state: on ? "on" : "off", reenabled, notify: reenabled && !record.notified, seed: false };
}

// Switch label suffix for each state: "loading" before the first read,
// "unknown" after a failed read (the switch is indeterminate, never "off").
export function mdLabel(state) {
  if (state === "on") return "on";
  if (state === "off") return "off";
  if (state === "unknown") return "unknown";
  return "…";
}

export function retryDelay(attempt) {
  const i = Math.max(0, Math.min(attempt | 0, MD_RETRY_DELAYS.length - 1));
  return MD_RETRY_DELAYS[i];
}

// Text of the confirm shown before switching multi-device off. `reenabled`
// is the only "other device" signal the core gives us: it turned bcc_self
// back on since the user's last choice (sync from another device, transfer
// or backup).
export function offConfirmText(reenabled) {
  const base = t("With multi-device off, this device deletes messages from the relay after downloading them, so other devices using this profile stop receiving them.");
  return base + " " + (reenabled
    ? t("Multi-device was recently turned back on by a backup export, Add second device or a sync from another device, so another device may still be using this profile.")
    : t("Keep it on if you use this profile anywhere else."));
}
