// PWA-only liquid glass for the whole composer dock. Native shells keep the stock composer.
import { createLiquidGlass } from "../vendor/liquid-glass.js";

const host = document.getElementById("main-composer");
if (window.VELTA_PWA?.wasmCore && host) {
  host.classList.add("liquid-composer");
  // Keep the top-row sticker button still between pointerdown/up when the input blurs.
  document.getElementById("btn-sticker")?.addEventListener("pointerdown", (event) => event.preventDefault());
  const syncTheme = () => host.toggleAttribute("data-lg-dark", document.documentElement.dataset.theme !== "light");
  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const webglRequested = new URLSearchParams(location.search).get("glass") === "webgl";
  const glass = createLiquidGlass(host, {
    radius: 32,
    rim: 0.85,
    // Let Chromium's displacement remain visible; non-refracting engines need the frost fallback.
    blur: "userAgentData" in navigator ? 1.5 : 12,
    reflect: !webglRequested,
    reflectStrength: 1.6,
    promote: "#history-scroll",
  });
  // Element scroll does not bubble to the library's window listener.
  const scroll = document.getElementById("history-scroll");
  scroll?.addEventListener("scroll", () => {
    if (!host.classList.contains("webgl-ready")) glass.refresh();
  }, { passive: true });
  if (webglRequested) {
    import("./composer-webgl.js").then(({ createWebGLGlass }) => createWebGLGlass(host, scroll)).catch(() => {});
  }
}
