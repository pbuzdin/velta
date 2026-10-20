// Avatar color for a participant without a contact color (local-chat peers,
// group-call roster names): a stable hue from the name. Shared pattern.
export function nameColor(name) {
  let h = 0;
  for (const ch of String(name || "?")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 55%)`;
}
