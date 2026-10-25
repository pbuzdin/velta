// velta-strings.js — Velta's own wording for texts the chatmail core writes
// into the device chat. English here is the source; app/js/i18n.js translates
// these four strings at init when the UI language is French or Russian
// (jsonrpc set_stock_strings → Accounts::set_stock_translation). No core/
// change. Works the same on Tauri desktop/Android and the wasm PWA.
// Never mention relay hostnames here.

// StockMessage ids from core/src/stock_str.rs.
export const STOCK = Object.freeze({
  DeviceMessagesHint: 70,
  WelcomeMessage: 71,
  UpdateReminderMsgBody: 86,
  DonationRequest: 193,
});

export const DEVICE_CHAT_HINT =
  "This chat holds messages from Velta itself, like tips and updates. Only you see it, and it stays on this device.";

// The device chat renders through markdown.js like any bubble; the text is
// kept plain (emoji + "•" bullets) so it reads the same everywhere.
export const VELTA_WELCOME = `👋 Welcome to Velta!

Velta is a private messenger built on the chatmail network, so you can chat with anyone on Delta Chat too. A few things you'll only find in Velta:

• Velta Circle: group audio calls for up to 6 people
• Velta Beam: send files straight to people in the chat
• Video calls that switch between audio and video anytime
• Reply threads that show every reply to a message in one place
• Your relay, your choice: pick which relay sends your messages, and see live whether each relay is sending fine or can't be reached
• Chat categories: filter your chat list with quick chips, like Unread
• Velta in your browser at https://velta.cc/web

Tips, news and downloads are at https://velta.cc.
The Velta team`;

export const UPDATE_REMINDER =
  "⚠️ Your Velta version might be outdated.\n\n" +
  "Your chat partners may use newer apps, so some things can work less well, and you are missing the latest features.\n" +
  "Get the newest Velta at https://velta.cc or from your app store.";

export const ENJOYING_VELTA =
  "❤️ Glad you're enjoying Velta!\n\n" +
  "If Velta works well for you, tell a friend about it. Tips, news and downloads are at https://velta.cc.";

// Map handed to set_stock_strings. Core's "core-welcome" device message is
// built from WelcomeMessage during configure, so overriding it IS the Velta
// welcome: core adds it once (label "core-welcome") only to newly configured
// accounts; existing accounts already carry that label and imported
// backups are skipped by core.
export const STOCK_OVERRIDES = Object.freeze({
  [STOCK.DeviceMessagesHint]: DEVICE_CHAT_HINT,
  [STOCK.WelcomeMessage]: VELTA_WELCOME,
  [STOCK.UpdateReminderMsgBody]: UPDATE_REMINDER,
  [STOCK.DonationRequest]: ENJOYING_VELTA,
});

// Core also adds a Delta Chat photo ("core-welcome-image") at configure.
// Claiming the label with an empty message beforehand stops it for good.
export const SUPPRESSED_DEVICE_LABELS = Object.freeze(["core-welcome-image"]);
