// roaming-hint.js — #302: when the phone is on data roaming, offer Text-only
// mode ONCE per roaming episode. Nothing switches by itself, leaving roaming
// never reverts anything, and "Don't ask again" is remembered forever
// (velta-roaming-hint). Node-safe (no DOM).

export const ROAMING_DISMISSED_KEY = "velta-roaming-hint";

export function roamingHintDismissed(storage) {
  try { return storage?.getItem(ROAMING_DISMISSED_KEY) === "1"; } catch { return true; }
}

export function dismissRoamingHintForever(storage) {
  try { storage?.setItem(ROAMING_DISMISSED_KEY, "1"); } catch {}
}

// True only on the FIRST roaming observation of an episode (leaving roaming
// opens the next one), only while Text-only mode is off, and never after
// "Don't ask again".
let seenRoaming = false;
export function shouldAskRoaming({ roaming, mode, storage }) {
  if (roaming !== true) { seenRoaming = false; return false; }
  const entering = !seenRoaming;
  seenRoaming = true;
  return entering && mode === "off" && !roamingHintDismissed(storage);
}

export function _resetRoamingEpisode() { seenRoaming = false; } // tests
