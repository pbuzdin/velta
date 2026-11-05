// Battery-optimization prompt (Android): asked ONCE — any answer or close is
// remembered in localStorage, so users who said no on purpose are not asked
// on every cold start. The drawer keeps a manual path ("Force background
// connection") plus a link to dontkillmyapp.com for the phone's maker,
// whose per-OEM pages explain the extra switches Xiaomi, Huawei, Samsung,
// … need beyond the Android exemption. Node-safe (no DOM).

export const BATTERY_DISMISSED_KEY = "velta-battery-opt-dismissed";

const DKMA = "https://dontkillmyapp.com/";
// Build.MANUFACTURER (lowercased) → dontkillmyapp.com page slug.
const MAKERS = {
  xiaomi: "xiaomi", redmi: "xiaomi", poco: "xiaomi",
  huawei: "huawei", honor: "huawei",
  samsung: "samsung",
  oneplus: "oneplus",
  oppo: "oppo",
  realme: "realme",
  vivo: "vivo",
  asus: "asus",
  lenovo: "lenovo",
  motorola: "motorola",
  meizu: "meizu",
  nokia: "nokia", "hmd global": "nokia",
  sony: "sony",
  google: "google",
  wiko: "wiko",
  blackview: "blackview",
};

/** The dontkillmyapp.com page for a Build.MANUFACTURER value (index if unknown). */
export function dontKillMyAppUrl(maker) {
  const m = String(maker || "").trim().toLowerCase();
  const slug = MAKERS[m];
  return slug ? DKMA + slug : DKMA;
}

/** Display name for the maker ("Xiaomi"), or "" when unknown. */
export function makerLabel(maker) {
  const m = String(maker || "").trim();
  return m ? m.charAt(0).toUpperCase() + m.slice(1) : "";
}

/** Ask only when not exempt and never answered before. */
export function shouldAskBattery({ exempt, storage }) {
  if (exempt) return false;
  try {
    return storage?.getItem(BATTERY_DISMISSED_KEY) !== "1";
  } catch {
    return false;
  }
}

export function rememberBatteryAnswer(storage) {
  try { storage?.setItem(BATTERY_DISMISSED_KEY, "1"); } catch {}
}
