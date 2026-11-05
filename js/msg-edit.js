// Which messages offer "Edit" (caption/text edit via core send_edit_request).
// Mirrors core chat.rs send_edit_request guards: own (from SELF), not info,
// not HTML (mime_modified), not a call, and non-empty original text (core
// refuses "Cannot add text" — so a captionless image can't gain a caption).
// Core has no viewtype/time-window restriction beyond Call; we additionally
// exclude webxdc (its text is the app's summary, not a user caption) and
// stickers (no caption UI). Not P2P: local-chat ids are a different space.
export const EDITABLE_VIEWTYPES = new Set(["text", "image", "gif", "video", "audio", "voice", "file", "vcard"]);

export function canEditMsg(m, chat) {
  if (!m || chat?.isP2p) return false;
  if (m.from !== 1 || m.isInfo || m.kind === "info" || m.hasHtml) return false;
  if (!EDITABLE_VIEWTYPES.has(m.viewtype)) return false;
  return typeof m.text === "string" && m.text.trim() !== "";
}
