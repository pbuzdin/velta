const base = "http://127.0.0.1:9223";
let list = await fetch(base + "/json/list").then(r => r.json());
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params) => new Promise((res) => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({ error: "timeout" }); } }, 10000);
});
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
console.log("hard reload done");
ws.close();
