import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

// Issue #20: a notification tap hands the WebView
// velta://chat?account=&chat=&t= (Android VIEW intent from Notifications.kt,
// Windows toast activation in lib.rs). Run the production deep-link router
// from app.js, not a copy: it must select the notified profile first, then
// open the chat, and fall back to doing nothing (app stays focused) when
// the profile or chat is gone. Issue #23: a chat link whose t does not
// match the shell token is ignored.
// chatLinkToken is a free global in the sliced router (the let lives above
// the slice), so the vm context supplies it.
const source = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
const start = "function extractVeltaLink(";
const end = "// Ask what a clicked/pasted dcaccount";
const from = source.indexOf(start);
assert.notEqual(from, -1, `Missing app.js marker: ${start}`);
const to = source.indexOf(end, from);
assert.ok(to > from, `Missing app.js end marker: ${end}`);
const script = new Script(source.slice(from, to), {
  filename: "app/js/app.js",
  lineOffset: source.slice(0, from).split("\n").length - 1,
});

const TOKEN = "0123456789abcdef0123456789abcdef";
const chatUrl = (query) => `velta://chat?${query}&t=${TOKEN}`;

function setup({ accountId = 1, accounts = [{ id: 1 }, { id: 2 }], chats = { 1: [5], 2: [9] } } = {}) {
  const log = [];
  const core = {
    accountId,
    accountEpoch: 0,
    async getAllAccounts() { log.push(["getAllAccounts"]); return accounts; },
    async switchAccount(id) {
      log.push(["switchAccount", id]);
      ctx.state.accountChanging = true;
      this.accountEpoch++;
      await null;
      this.accountId = Number(id);
      this.accountEpoch++;
      ctx.state.accountChanging = false;
      return { id };
    },
    async getChat(chatId) {
      log.push(["getChat", this.accountId, chatId]);
      return (chats[this.accountId] || []).includes(chatId) ? { id: chatId } : null;
    },
  };
  const ctx = {
    URL, console, location: { href: "http://tauri.localhost/", pathname: "/" },
    history: { replaceState() {} },
    core,
    state: { accountChanging: false, activeChatId: null },
    accountRefreshPromise: Promise.resolve(),
    accountIsCurrent: epoch => !ctx.state.accountChanging && epoch === core.accountEpoch,
    openChat: async chatId => { log.push(["openChat", core.accountId, chatId]); },
    toast: text => log.push(["toast", text]),
    errToast: text => log.push(["errToast", text]),
    // Other deep-link kinds are out of scope here.
    extractJoinLink: () => null,
    extractInviteLink: () => null,
    confirmModal: async () => false,
    chatLinkToken: TOKEN,
  };
  createContext(ctx);
  script.runInContext(ctx);
  return { ctx, core, log };
}

test("extractChatLink parses notification links and rejects everything else", () => {
  const { ctx } = setup();
  const parse = url => JSON.parse(JSON.stringify(ctx.extractChatLink(url)));
  assert.deepEqual(parse(chatUrl("account=2&chat=9")), { accountId: 2, chatId: 9, token: TOKEN });
  assert.deepEqual(parse("velta://chat?account=2&chat=9"), { accountId: 2, chatId: 9, token: null });
  assert.deepEqual(parse("velta://chat?chat=9"), { accountId: null, chatId: 9, token: null });
  assert.deepEqual(parse("velta://chat?account=0&chat=9"), { accountId: null, chatId: 9, token: null });
  for (const bad of [
    "velta://chat?account=2",
    "velta://chat?account=2&chat=0",
    "velta://chat?account=2&chat=abc",
    "velta://invite?url=https%3A%2F%2Fi.delta.chat%2F",
    "https://chat/?chat=9",
    "http://tauri.localhost/",
    "not a url",
  ]) {
    assert.equal(ctx.extractChatLink(bad), null, bad);
  }
});

test("same-account tap opens the chat without switching", async () => {
  const { ctx, log } = setup();
  await ctx.handleDeeplinkFromUrl(chatUrl("account=1&chat=5"));
  assert.deepEqual(log, [["getChat", 1, 5], ["openChat", 1, 5]]);
});

test("tap for another profile selects it before opening the chat", async () => {
  const { ctx, core, log } = setup();
  await ctx.handleDeeplinkFromUrl(chatUrl("account=2&chat=9"));
  assert.equal(core.accountId, 2);
  assert.deepEqual(log, [["getAllAccounts"], ["switchAccount", 2], ["getChat", 2, 9], ["openChat", 2, 9]]);
});

test("tap for a profile that no longer exists leaves the app as it is", async () => {
  const { ctx, core, log } = setup();
  await ctx.handleDeeplinkFromUrl(chatUrl("account=3&chat=9"));
  assert.equal(core.accountId, 1);
  assert.deepEqual(log, [["getAllAccounts"]]);
});

test("tap for a deleted chat toasts instead of opening", async () => {
  const { ctx, log } = setup();
  await ctx.handleDeeplinkFromUrl(chatUrl("account=1&chat=77"));
  assert.deepEqual(log.map(e => e[0]), ["getChat", "toast"]);
});

test("a tap during an account switch is ignored", async () => {
  const { ctx, log } = setup();
  ctx.state.accountChanging = true;
  await ctx.handleDeeplinkFromUrl(chatUrl("account=1&chat=5"));
  assert.deepEqual(log, []);
});

test("an account switch racing the chat lookup drops the open", async () => {
  const { ctx, core, log } = setup();
  core.getChat = async chatId => { log.push(["getChat", chatId]); core.accountEpoch++; return { id: chatId }; };
  await ctx.handleDeeplinkFromUrl(chatUrl("account=1&chat=5"));
  assert.deepEqual(log, [["getChat", 5]]);
});

test("a Windows toast tap queues the chat link before the wake-up emit", () => {
  const lib = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  const start = lib.indexOf("toast = toast.on_activated");
  assert.ok(start > 0);
  const body = lib.slice(start, lib.indexOf("Ok(())", start));
  const queue = body.indexOf("queue_opened(link.clone())");
  const emit = body.indexOf("app.emit(\"deeplink\"");
  assert.ok(queue >= 0 && emit > queue);
});

test("a chat link without this install's token does not open", async () => {
  const { ctx, log } = setup();
  await ctx.handleDeeplinkFromUrl("velta://chat?account=2&chat=9");
  await ctx.handleDeeplinkFromUrl("velta://chat?account=2&chat=9&t=deadbeefdeadbeefdeadbeefdeadbeef");
  ctx.chatLinkToken = "";
  await ctx.handleDeeplinkFromUrl(chatUrl("account=2&chat=9"));
  assert.deepEqual(log, []);
});
