import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";

const A = 1;
const B = 2;
const CHAT = 10;
const MSG = 20;
const QR = "dcaccount:https://relay.example/new";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function message(id = MSG) {
  return { kind: "message", id, chatId: CHAT, fromId: 1, state: 26, text: "source", timestamp: 1 };
}

function fixture(handlers = {}) {
  const core = new JsonRpcCore({});
  core.accountId = A;
  const calls = [];
  const events = [];
  const backend = { selected: A };
  core._call = async (method, ...params) => {
    calls.push([method, ...params]);
    if (Object.hasOwn(handlers, method)) return handlers[method](...params);
    switch (method) {
      case "select_account": backend.selected = params[0]; return;
      case "get_selected_account_id": return backend.selected;
      case "get_account_info": return { kind: "Configured", addr: `account${params[0]}@example.org` };
      case "get_contact": return { id: 1, color: "#123456", profileImage: `avatar-${params[0]}` };
      case "get_message": return message(params[1]);
      default: throw new Error(`Unexpected RPC: ${method}`);
    }
  };
  core._callWithTimeout = (timeout, method, ...params) => core._call(method, ...params);
  for (const name of [
    "account-changing", "account-changed", "chat-updated", "msgs-changed",
    "incoming-msg", "msg-updated", "msg-state", "msg-sent", "msgs-deleted",
    "configure-progress", "diagnostic",
  ]) {
    core.addEventListener(name, event => events.push({ name, detail: event.detail }));
  }
  return { core, calls, events, backend };
}

test("polling forwards camelCase and legacy snake_case context IDs, never guessing attribution", async t => {
  const exhausted = deferred();
  const queue = [
    { contextId: A, event: { kind: "MsgDelivered", chatId: CHAT, msgId: MSG } },
    { context_id: A, event: { kind: "MsgRead", chat_id: CHAT, msg_id: MSG } },
    { contextId: B, context_id: A, event: { kind: "MsgsChanged", chatId: CHAT, msgId: MSG } },
    { event: { kind: "MsgFailed", chatId: CHAT, msgId: MSG } },
  ];
  const { core, events } = fixture({
    get_next_event() {
      if (queue.length) return queue.shift();
      exhausted.resolve();
      return new Promise(() => {});
    },
  });
  // Park the endless poller on an unresolved RPC after draining this test queue.
  t.mock.method(globalThis, "setTimeout", callback => queueMicrotask(callback));
  core.msgIdCache.set(CHAT, [MSG]);
  void core._pollEvents();
  await exhausted.promise;
  assert.deepEqual(events, [
    { name: "msg-state", detail: { chatId: CHAT, msgId: MSG, state: "delivered" } },
    { name: "msg-state", detail: { chatId: CHAT, msgId: MSG, state: "read" } },
  ]);
  assert.deepEqual(core.msgIdCache.get(CHAT), [MSG]);
});

test("foreign and unattributed account events cannot mutate caches, emit UI events, or fetch messages", async () => {
  const { core, calls, events } = fixture();
  core.msgIdCache.set(CHAT, [MSG]);
  for (const contextId of [B, undefined, null, 0, String(A)]) {
    for (const kind of [
      "IncomingMsg", "IncomingMsgBunch", "MsgsChanged", "MsgDelivered", "MsgRead",
      "MsgReadCountChanged", "MsgFailed", "ConfigureProgress", "ChatlistChanged",
      "ChatlistItemChanged", "ChatModified", "MsgsNoticed",
    ]) {
      await core._handleCoreEvent({ kind, chatId: CHAT, msgId: MSG }, contextId);
    }
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
  assert.deepEqual(core.msgIdCache.get(CHAT), [MSG]);
  await core._handleCoreEvent({ kind: "Warning", msg: "global diagnostic" });
  assert.equal(events[0].name, "diagnostic");
});

for (const [kind, emitted] of [["IncomingMsg", "incoming-msg"], ["MsgsChanged", "msg-updated"]]) {
  test(`${kind} decorates current messages but discards a late A -> B -> A result`, async () => {
    const gate = deferred();
    const { core, calls, events } = fixture();
    await core._handleCoreEvent({ kind, chatId: CHAT, msgId: MSG }, A);
    assert.equal(events.at(-1).name, emitted);
    const originalCall = core._call;
    core._call = (method, ...params) => method === "get_message"
      ? (calls.push([method, ...params]), gate.promise)
      : originalCall(method, ...params);
    const pending = core._handleCoreEvent({ kind, chat_id: CHAT, msg_id: MSG }, A);
    assert.deepEqual(calls.at(-1), ["get_message", A, MSG]);
    await core.switchAccount(B);
    await core.switchAccount(A);
    core.msgIdCache.set(CHAT, [99]);
    events.length = 0;
    gate.resolve(message());
    await pending;
    assert.deepEqual(events, []);
    assert.deepEqual(core.msgIdCache.get(CHAT), [99]);
  });
}

test("history keeps the entry account across RPCs and cannot contaminate B or a new A epoch", async () => {
  for (const destination of [B, A]) {
    const gate = deferred();
    const { core, calls } = fixture({
      get_message_ids: () => gate.promise,
      get_messages: () => ({ [MSG]: message() }),
    });
    const originalCache = core.msgIdCache;
    const pending = core.getMessages(CHAT, { fresh: true });
    await core.switchAccount(B);
    if (destination === A) await core.switchAccount(A);
    core.msgIdCache.set(CHAT, [99]);
    gate.resolve([MSG]);
    const result = await pending;
    assert.equal(result.messages[0].text, "source");
    assert.deepEqual(calls.filter(([method]) => ["get_message_ids", "get_messages"].includes(method)), [
      ["get_message_ids", A, CHAT, false, false], ["get_messages", A, [MSG]],
    ]);
    assert.notEqual(core.msgIdCache, originalCache);
    assert.deepEqual(core.msgIdCache.get(CHAT), [99]);
    assert.equal(originalCache.size, 0);
  }
});

test("current history still caches and paginates normally", async () => {
  const { core, calls } = fixture({
    get_message_ids: () => [20, 21, 22],
    get_messages: (_, ids) => Object.fromEntries(ids.map(id => [id, message(id)])),
  });
  const tail = await core.getMessages(CHAT, { limit: 2 });
  const head = await core.getMessages(CHAT, { beforeId: 21, limit: 2 });
  assert.deepEqual(tail.messages.map(m => m.id), [21, 22]);
  assert.equal(tail.hasMore, true);
  assert.deepEqual(head.messages.map(m => m.id), [20]);
  assert.equal(head.hasMore, false);
  assert.equal(calls.filter(([method]) => method === "get_message_ids").length, 1);
});

test("a pending send completes on its source without foreign cache writes or msg-sent", async () => {
  const gate = deferred();
  const { core, calls, events } = fixture({ send_msg: () => gate.promise });
  core.msgIdCache.set(CHAT, [19]);
  const pending = core.sendMessage(CHAT, { text: "hello" });
  await core.switchAccount(B);
  core.msgIdCache.set(CHAT, [99]);
  events.length = 0;
  gate.resolve(MSG);
  assert.equal((await pending).id, MSG);
  assert.deepEqual(calls.at(-1), ["get_message", A, MSG]);
  assert.deepEqual(core.msgIdCache.get(CHAT), [99]);
  assert.deepEqual(events, []);
});

test("current-account send and delete still update the cache and notify the UI", async () => {
  const { core, events } = fixture({ send_msg: () => MSG, delete_messages: () => {} });
  core.msgIdCache.set(CHAT, [19]);
  await core.sendMessage(CHAT, { text: "hello" });
  assert.deepEqual(core.msgIdCache.get(CHAT), [19, MSG]);
  assert.equal(events.at(-1).name, "msg-sent");
  events.length = 0;
  await core.deleteMessages(CHAT, [MSG]);
  assert.deepEqual(core.msgIdCache.get(CHAT), [19]);
  assert.deepEqual(events.map(event => event.name), ["msgs-deleted", "chat-updated"]);
});

test("prepared-message retries retain the send account and discard late completion", async t => {
  const gate = deferred();
  const polling = deferred();
  let attempts = 0;
  const { core, calls, events } = fixture({
    send_msg: () => MSG,
    get_message: () => {
      if (++attempts === 1) return { ...message(), state: 18 };
      polling.resolve();
      return gate.promise;
    },
  });
  t.mock.method(globalThis, "setTimeout", callback => queueMicrotask(callback));
  const pending = core.sendMessage(CHAT, { file: "source.jpg", viewtype: "image" });
  await polling.promise;
  await core.switchAccount(B);
  await core.switchAccount(A);
  events.length = 0;
  gate.resolve(message());
  await pending;
  assert.deepEqual(calls.filter(([method]) => method === "get_message"), [
    ["get_message", A, MSG], ["get_message", A, MSG],
  ]);
  assert.deepEqual(events, []);
});

test("send fallback decoration uses the original account", async t => {
  const gate = deferred();
  const { core, calls, events } = fixture({ send_msg: () => MSG });
  t.mock.method(core, "_waitForPreparedMessage", (id, accountId) => {
    assert.equal(id, MSG);
    assert.equal(accountId, A);
    return gate.promise;
  });
  const pending = core.sendMessage(CHAT);
  await core.switchAccount(B);
  events.length = 0;
  gate.resolve(null);
  await pending;
  assert.deepEqual(calls.at(-1), ["get_message", A, MSG]);
  assert.deepEqual(events, []);
});

const multiStepCases = [
  {
    name: "markRead", run: core => core.markRead(CHAT),
    steps: [["get_message_ids", A, CHAT, false, false], ["markseen_msgs", A, [MSG]]],
    results: [[MSG], null],
  },
  {
    name: "chat flags", run: core => core.setChatFlags(CHAT, { pinned: true, muted: true }),
    steps: [["set_chat_visibility", A, CHAT, "Pinned"], ["set_chat_mute_duration", A, CHAT, "Forever"]],
    results: [null, null],
  },
  {
    name: "group creation and members", run: core => core.createChat("group", [11, 12]),
    steps: [["create_group_chat", A, "group", false], ["add_contact_to_chat", A, CHAT, 11], ["add_contact_to_chat", A, CHAT, 12]],
    results: [CHAT, null, null],
  },
  {
    name: "QR configuration and IO", run: core => core.configureWithQr(QR),
    steps: [["set_config_from_qr", A, QR], ["start_io", A]],
    results: [null, null],
  },
  {
    name: "member lookup", run: core => core.getChatMembers(CHAT),
    steps: [["get_full_chat_by_id", A, CHAT], ["get_contacts_by_ids", A, [1, 11]]],
    results: [{ contactIds: [0, 1, 5, 11] }, { 1: { id: 1 }, 11: { id: 11 } }],
  },
  {
    name: "reaction decoration", run: core => core.addReaction(CHAT, MSG, ":)"),
    steps: [["send_reaction", A, MSG, [":)"]], ["get_message", A, MSG]],
    results: [null, message()],
  },
  {
    name: "chat list", run: core => core.getChatList(),
    steps: [["get_chatlist_entries", A, null, null, null], ["get_chatlist_items_by_entries", A, [CHAT]]],
    results: [[CHAT], { [CHAT]: { kind: "ChatListItem", id: CHAT } }],
  },
  {
    name: "chat fallback", run: core => core.getChat(CHAT),
    steps: [["get_chatlist_entries", A, null, null, null], ["get_basic_chat_info", A, CHAT]],
    results: [[], { name: "source chat" }],
  },
];

for (const { name, run, steps, results } of multiStepCases) {
  test(`${name} stays on its entry account through every await`, async () => {
    const gate = deferred();
    let index = 0;
    const handlers = Object.fromEntries(steps.map(([method]) => [method, () => {
      const current = index++;
      return current === 0 ? gate.promise : results[current];
    }]));
    const { core, calls, events } = fixture(handlers);
    const pending = run(core);
    await core.switchAccount(B);
    events.length = 0;
    gate.resolve(results[0]);
    await pending;
    assert.deepEqual(calls.filter(([method]) => Object.hasOwn(handlers, method)), steps);
    assert.deepEqual(events, []);
    assert.equal(core.msgIdCache.size, 0);
  });
}

test("getAccount returns an internally consistent entry snapshot, including unconfigured accounts", async () => {
  for (const kind of ["Configured", "Unconfigured"]) {
    const gate = deferred();
    const { core, calls } = fixture({
      get_account_info: id => id === A ? gate.promise : { kind: "Unconfigured" },
    });
    const pending = core.getAccount();
    await core.switchAccount(B);
    gate.resolve({ kind, addr: "source@example.org" });
    const account = await pending;
    assert.equal(account.id, A);
    assert.equal(account.configured, kind === "Configured");
    if (account.configured) {
      assert.equal(account.avatar, "avatar-1");
      assert.deepEqual(calls.at(-1), ["get_contact", A, 1]);
    }
  }
});

test("getAllAccounts marks the selection captured before its first await", async () => {
  const gate = deferred();
  const { core } = fixture({ get_all_account_ids: () => gate.promise });
  const pending = core.getAllAccounts();
  await core.switchAccount(B);
  gate.resolve([A, B]);
  assert.deepEqual((await pending).map(account => account.isCurrent), [true, false]);
});

for (const [name, method, run] of [
  ["accept", "accept_chat", core => core.acceptChat(CHAT)],
  ["block", "block_chat", core => core.blockChat(CHAT)],
  ["delete", "delete_messages", core => core.deleteMessages(CHAT, [MSG])],
  ["delete for all", "delete_messages_for_all", core => core.deleteMessages(CHAT, [MSG], { forAll: true })],
  ["star", "save_msgs", core => core.starMessages(CHAT, [MSG])],
  ["forward", "forward_messages", core => core.forwardMessages(CHAT, [MSG], 11)],
  ["credentials", "add_transport", core => core.configureWithCredentials("source@example.org", "password")],
  ["secure join", "secure_join", core => core.secureJoin("invite")],
]) {
  test(`${name} completion cannot mutate another account's cache or emit its UI events`, async () => {
    const gate = deferred();
    const { core, calls, events } = fixture({ [method]: () => gate.promise });
    const pending = run(core);
    assert.equal(calls[0][1], A);
    await core.switchAccount(B);
    core.msgIdCache.set(CHAT, [MSG, 99]);
    events.length = 0;
    gate.resolve(CHAT);
    await pending;
    assert.deepEqual(core.msgIdCache.get(CHAT), [MSG, 99]);
    assert.deepEqual(events, []);
  });
}

test("switch boundaries are synchronous at start, invalidate twice, and reject overlapping transitions", async () => {
  const gate = deferred();
  const { core, calls, events, backend } = fixture({
    select_account: async id => { await gate.promise; backend.selected = id; },
  });
  core.msgIdCache.set(CHAT, [MSG]);
  const oldCache = core.msgIdCache;
  assert.equal(core.accountEpoch, 0);
  core.addEventListener("account-changing", () => {
    assert.equal(calls.length, 0);
    assert.equal(core.accountEpoch, 1);
    assert.equal(core.msgIdCache.size, 0);
  }, { once: true });
  const pending = core.switchAccount(B);
  assert.equal(events[0].name, "account-changing");
  assert.equal(core.accountId, A);
  assert.notEqual(core.msgIdCache, oldCache);
  const intermediateCache = core.msgIdCache;
  await assert.rejects(core.switchAccount(3), /transition already in progress/);
  await assert.rejects(core.addAccountWithQr(QR), /transition already in progress/);
  assert.deepEqual(calls, [["select_account", B]]);
  assert.equal(core.accountEpoch, 1);
  gate.resolve();
  const account = await pending;
  assert.equal(account.id, B);
  assert.equal(core.accountId, B);
  assert.equal(core.accountEpoch, 2);
  assert.equal(core._accountTransitionBusy, false);
  assert.notEqual(core.msgIdCache, intermediateCache);
  assert.deepEqual(events.map(event => [event.name, event.detail]), [
    ["account-changing", { accountId: A, accountEpoch: 1 }],
    ["account-changed", { accountId: B, accountEpoch: 2 }],
  ]);
});

test("work started during selection cannot publish or cache during or after the transition", async () => {
  const selected = deferred();
  const history = deferred();
  const { core, events } = fixture({
    select_account: () => selected.promise,
    get_message_ids: () => history.promise,
    get_messages: () => ({ [MSG]: message() }),
    send_msg: () => MSG,
  });
  const transition = core.switchAccount(B);
  const pending = core.getMessages(CHAT);
  await core.sendMessage(CHAT);
  await core._handleCoreEvent({ kind: "IncomingMsg", chatId: CHAT, msgId: MSG }, A);
  assert.deepEqual(events.map(event => event.name), ["account-changing"]);
  assert.equal(core.msgIdCache.size, 0);
  selected.resolve();
  await transition;
  core.msgIdCache.set(CHAT, [99]);
  events.length = 0;
  history.resolve([MSG]);
  await pending;
  assert.deepEqual(core.msgIdCache.get(CHAT), [99]);
  assert.deepEqual(events, []);
});

test("selection failures reconcile actual backend selection and always release the transition", async () => {
  for (const changedBeforeFailure of [false, true]) {
    const failure = new Error("select failed");
    const { core, events, backend } = fixture({
      select_account: id => {
        if (changedBeforeFailure) backend.selected = id;
        throw failure;
      },
    });
    await assert.rejects(core.switchAccount(B), error => error === failure);
    assert.equal(core.accountId, changedBeforeFailure ? B : A);
    assert.equal(core.accountEpoch, 2);
    assert.equal(core._accountTransitionBusy, false);
    assert.equal(events.at(-1).name, "account-changed");
    assert.equal(events.at(-1).detail.accountId, core.accountId);
  }
});

test("reconciliation failure preserves the original error and last known selection", async () => {
  const failure = new Error("selection unavailable");
  const { core, events } = fixture({
    select_account: () => { throw failure; },
    get_selected_account_id: () => { throw new Error("offline"); },
  });
  await assert.rejects(core.switchAccount(B), error => error === failure);
  assert.equal(core.accountId, A);
  assert.equal(core.accountEpoch, 2);
  assert.equal(core._accountTransitionBusy, false);
  assert.deepEqual(events.map(event => event.name), ["account-changing", "diagnostic", "account-changed"]);
});

for (const configured of [false, true]) {
  for (const fails of [false, true]) {
    test(`addAccountWithQr (${configured ? "new" : "empty"} profile, ${fails ? "failure" : "success"}) uses both boundaries`, async () => {
      const gate = deferred();
      const configuring = deferred();
      const { core, calls, events } = fixture({
        get_account_info: () => ({ kind: configured ? "Configured" : "Unconfigured" }),
        add_account: () => B,
        set_config_from_qr: () => { configuring.resolve(); return gate.promise; },
        start_io: () => {},
      });
      const target = configured ? B : A;
      const pending = core.addAccountWithQr(QR);
      assert.equal(core.accountEpoch, 1);
      assert.equal(events[0].name, "account-changing");
      assert.equal(calls[0][0], "get_account_info");
      await configuring.promise;
      await assert.rejects(core.switchAccount(3), /transition already in progress/);
      await assert.rejects(core.addAccountWithQr(QR), /transition already in progress/);
      assert.equal(core.accountId, target);
      await core._handleCoreEvent({ kind: "ConfigureProgress", progress: 500 }, target);
      assert.equal(events.at(-1).name, "configure-progress");
      if (fails) {
        const rejected = assert.rejects(pending, /configuration failed/);
        gate.reject(new Error("configuration failed"));
        await rejected;
      } else {
        gate.resolve();
        assert.equal(await pending, target);
      }
      assert.equal(core.accountId, target);
      assert.equal(core.accountEpoch, 2);
      assert.equal(core._accountTransitionBusy, false);
      assert.equal(core.msgIdCache.size, 0);
      assert.deepEqual(events.at(-1), {
        name: "account-changed", detail: { accountId: target, accountEpoch: 2 },
      });
      assert.deepEqual(calls.filter(([method]) => ["set_config_from_qr", "start_io"].includes(method)), [
        ["set_config_from_qr", target, QR], ...(!fails ? [["start_io", target]] : []),
      ]);
    });
  }
}

test("invalid invite rejection does not start an account transition", async () => {
  const { core, calls, events } = fixture();
  await assert.rejects(core.addAccountWithQr("not-an-invite"), /not a relay invite link/);
  assert.equal(core.accountEpoch, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
});

test("a synchronous UI listener starting a switch suppresses remaining old-epoch emissions", async () => {
  const { core, calls, events } = fixture();
  let transition;
  core.addEventListener("chat-updated", () => { transition = core.switchAccount(B); }, { once: true });
  await core._handleCoreEvent({ kind: "IncomingMsg", chatId: CHAT, msgId: MSG }, A);
  await transition;
  assert.deepEqual(calls.find(([method]) => method === "get_message"), ["get_message", A, MSG]);
  assert.equal(events.some(event => ["msgs-changed", "incoming-msg"].includes(event.name)), false);
});
