// Side-effect import for tests with STATIC imports of modules that reach
// components.js (custom elements need HTMLElement): ES module evaluation
// runs every static import before any statement of the importing test, so
// calling installChatViewGlobals() from the test body is too late — import
// this BEFORE the app module instead.
import { installChatViewGlobals } from "./fake-dom.mjs";
installChatViewGlobals();
