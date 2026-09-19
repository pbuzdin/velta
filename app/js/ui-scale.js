// Interface scale (drawer option) applies before first paint to avoid a flash.
// Blocking <script src> in <head>, same timing as the old inline block; kept
// external so the CSP can forbid inline scripts.
try {
  const s = localStorage.getItem("velta-ui-scale");
  if (s && s !== "1") document.documentElement.style.zoom = s;
} catch {}
