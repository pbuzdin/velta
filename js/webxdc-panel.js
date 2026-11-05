// #138: which webxdc apps open as a bottom panel instead of full screen
// (see webxdc-manager.js openWebxdc). Layout only — not a trust decision.
export const PANEL_APP_NAMES = new Set(["Velta Beam"]);
export function wantsPanel(name, opts = {}) {
  return opts.panel === true || PANEL_APP_NAMES.has(String(name || ""));
}
