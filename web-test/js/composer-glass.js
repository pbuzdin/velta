// PWA-only liquid glass for the message field. Native shells keep the stock composer.
import { createLiquidGlass } from "../vendor/liquid-glass.js";

const host = document.querySelector("#main-composer .composer-input-wrap");
if (window.VELTA_PWA?.wasmCore && host) {
  host.classList.add("liquid-composer");
  const syncTheme = () => host.toggleAttribute("data-lg-dark", document.documentElement.dataset.theme !== "light");
  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const glass = createLiquidGlass(host, {
    radius: 18,
    rim: 0.85,
    blur: 2,
    reflectStrength: 1.6,
    promote: "#history-scroll",
  });
  // Element scroll does not bubble to the library's window listener.
  document.getElementById("history-scroll")?.addEventListener("scroll", glass.refresh, { passive: true });
}
