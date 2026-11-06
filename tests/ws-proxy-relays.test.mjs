// Administrator-approved Chatmail relay registry in the standalone WS proxy.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const sh = readFileSync(join(here, "../tools/deploy-ws-proxy.sh"), "utf8");
const start = sh.indexOf("cat > \"$LIB/bridge.py\" <<'PY'\n");
const bridge = sh.slice(sh.indexOf("\n", start) + 1).split("\nPY\n", 1)[0];
const hasWs = spawnSync("python3", ["-c", "import websockets"]).status === 0;

const DRIVER = String.raw`
import asyncio, importlib.util, json, os, sys
bridge, registry = sys.argv[1:3]
spec = importlib.util.spec_from_file_location("bridge", bridge)
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
b.ALLOW_HOSTS = {"local.example.org"}
b.RELAYS_FILE = registry
out = {}
out["empty"] = sorted(b.allowed_hosts())
json.dump({"v": 1, "relays": {"alpha": "Mail.Example.Org."}}, open(registry, "w"))
out["added"] = sorted(b.allowed_hosts())
out["normalized"] = b.read_relays()
json.dump({"v": 1, "relays": {"alpha": "mail.example.org", "other": "other.example.org"}}, open(registry, "w"))
out["dynamic"] = sorted(b.allowed_hosts())
for i, bad in enumerate([
    [],
    {"v": 1, "relays": {"BAD": "mail.example.org"}},
    {"v": 1, "relays": {"x": "127.0.0.1"}},
    {"v": 1, "relays": {"x": "bad_host.example.org"}},
]):
    json.dump(bad, open(registry, "w"))
    assert b.read_relays() == {}
    assert b.allowed_hosts() == {"local.example.org"}, f"bad registry {i} widened access"
out["bad_registries_fail_closed"] = True
os.unlink(registry)
check_chatmail = b.check_chatmail
b.check_chatmail = b.normalize_host
b.add_relay("alpha", "Mail.Example.Org.")
out["first_add"] = json.load(open(registry))
b.add_relay("other", "other.example.org")
out["second_add"] = json.load(open(registry))
json.dump({"v": 1, "relays": {"BAD": "mail.example.org"}}, open(registry, "w"))
try:
    b.add_relay("new", "new.example.org")
    raise AssertionError("invalid existing registry was replaced")
except ValueError:
    pass
b.check_chatmail = check_chatmail

class Response:
    def __init__(self, url, body): self.url, self.body = url, body
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def geturl(self): return self.url
    def read(self, n): return self.body.encode()
b.socket.getaddrinfo = lambda *args, **kwargs: [(None, None, None, None, ("93.184.216.34", 443))]
b.urlopen = lambda *args, **kwargs: Response("https://mail.example.org/", "DCACCOUNT:https://mail.example.org/new")
assert b.check_chatmail("Mail.Example.Org.") == "mail.example.org"
b.urlopen = lambda *args, **kwargs: Response("https://mail.example.org/", "not chatmail")
try:
    b.check_chatmail("mail.example.org")
    raise AssertionError("non-Chatmail host accepted")
except SystemExit:
    pass
b.urlopen = lambda *args, **kwargs: Response("https://other.example.org/", "DCACCOUNT:https://mail.example.org/new")
try:
    b.check_chatmail("mail.example.org")
    raise AssertionError("cross-origin redirect accepted")
except SystemExit:
    pass
out["chatmail_validation"] = True

class Ws:
    def __init__(self): self.sent = []; self.closed = None
    async def send(self, value): self.sent.append(value)
    async def close(self, *args): self.closed = args
async def dns():
    json.dump({"v": 1, "relays": {"alpha": "mail.example.org"}}, open(registry, "w"))
    async def resolve(host): return ["93.184.216.34"] if host == "mail.example.org" else []
    b.resolve = resolve
    ws = Ws(); await b.handler(ws, "/dns/Mail.Example.Org.")
    return [json.loads(x) for x in ws.sent]
out["dns"] = asyncio.run(dns())

class MintResponse(Response):
    pass
mint_calls = []
def mint_urlopen(req, timeout):
    mint_calls.append((req.full_url, req.get_method()))
    return MintResponse("https://mail.example.org/new", '{"email":"random@mail.example.org","password":"synthetic"}')
async def ws_signup():
    b.urlopen = mint_urlopen
    ws = Ws(); await b.handler(ws, "/cm-new/Mail.Example.Org.")
    assert isinstance(ws.sent[0], str)
    assert json.loads(ws.sent[0])["email"] == "random@mail.example.org"
    before = len(mint_calls)
    denied = Ws(); await b.handler(ws=denied, path="/cm-new/not-allowed.example.org")
    assert denied.closed[0] == 1008 and len(mint_calls) == before
    b.urlopen = lambda req, timeout: MintResponse("https://other.example.org/new", '{"email":"random@mail.example.org","password":"synthetic"}')
    redirected = Ws(); await b.handler(redirected, "/cm-new/mail.example.org")
    assert redirected.closed[0] == 1011
asyncio.run(ws_signup())
assert mint_calls[0] == ("https://mail.example.org/new", "POST")
out["chatmail_ws_signup"] = True
print(json.dumps(out))
`;

test("relay registry is normalized, dynamic, fail-closed, and Chatmail-checked", { skip: !hasWs && "python3 websockets missing" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "velta-wsrelays-"));
  const bridgePath = join(dir, "bridge.py");
  const registry = join(dir, "relays.json");
  writeFileSync(bridgePath, bridge);
  const r = spawnSync("python3", ["-c", DRIVER, bridgePath, registry], { encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.deepEqual(out.empty, ["local.example.org"]);
  assert.deepEqual(out.added, ["local.example.org", "mail.example.org"]);
  assert.deepEqual(out.normalized, { alpha: "mail.example.org" });
  assert.deepEqual(out.dynamic, ["local.example.org", "mail.example.org", "other.example.org"]);
  assert.equal(out.bad_registries_fail_closed, true);
  assert.deepEqual(out.first_add, { v: 1, relays: { alpha: "mail.example.org" } });
  assert.deepEqual(out.second_add.relays, { alpha: "mail.example.org", other: "other.example.org" });
  assert.equal(out.chatmail_validation, true);
  assert.deepEqual(out.dns, [["93.184.216.34"]]);
  assert.equal(out.chatmail_ws_signup, true);
});
