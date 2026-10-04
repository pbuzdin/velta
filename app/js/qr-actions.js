// qr-actions.js — logic behind the "Your QR code" screen (#37), kept free of
// DOM so it can be unit-tested: which tabs/buttons exist on this platform,
// copy / share of the invite link, and what a scanned code is.

export const isMobileUa = ua => /Android|iPhone|iPad|iPod/i.test(String(ua || ""));
export const isAndroidUa = ua => /Android/i.test(String(ua || ""));

// The "Scan a QR code" tab exists on phones only (desktops have no useful
// camera workflow for this) and only when the WebView exposes a camera API.
export function scanTabAvailable({ ua, hasCamera }) {
  return isMobileUa(ua) && !!hasCamera;
}

// "Share a link" is offered when a native share path exists: the Android
// shell command, or the Web Share API (WebView2 on Windows, Safari).
export function canShareLink({ ua, hasInvoke, hasWebShare }) {
  return (isAndroidUa(ua) && !!hasInvoke) || !!hasWebShare;
}

export async function copyLink(link, { clipboard }) {
  if (!link) throw new Error("no link to copy");
  if (!clipboard?.writeText) throw new Error("clipboard is not available");
  await clipboard.writeText(link);
}

// → "shared" | "cancelled". Throws when no path works (caller shows a toast).
// Android: the shell's share_text command (WebView has no Web Share). Elsewhere
// navigator.share; a user dismissing the sheet (AbortError) is not an error.
export async function shareLink(link, { ua, invoke, webShare, title = "Velta invite" }) {
  if (!link) throw new Error("no link to share");
  if (isAndroidUa(ua) && invoke) {
    await invoke("share_text", { text: link, title });
    return "shared";
  }
  if (webShare) {
    try {
      await webShare({ title, text: link });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
      throw err;
    }
  }
  throw new Error("sharing is not available here");
}

// What did the camera read? Only things the app knows how to act on count; an
// arbitrary URL or text never reaches a handler.
//   invite  — SecureJoin contact/group invite (any registered host, OPENPGP4FPR:)
//   short   — deltachat.id style short invite link
//   relay   — dcaccount: / dclogin: relay or account invite
//   backup  — dcbackup: second-device transfer
export function classifyScannedCode(code, { parseInviteLink, isShortInviteLink }) {
  const s = String(code || "").trim();
  if (!s) return null;
  if (/^dcbackup\d*:/i.test(s)) return "backup";
  if (/^(dcaccount|dclogin):/i.test(s)) return "relay";
  if (parseInviteLink(s)) return "invite";
  if (isShortInviteLink(s)) return "short";
  return null;
}
