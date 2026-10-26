// Invite-link auth in the WebSocket proxy bridge (tools/deploy-ws-proxy.sh):
// runs the real bridge.py on 127.0.0.1 with AUTH=1 and checks valid, bad
// signature, expired, revoked and missing tokens at the handshake, plus the
// `--mint` link format. Skipped without python3 + websockets.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const sh = readFileSync(join(here, "../tools/deploy-ws-proxy.sh"), "utf8");
const start = sh.indexOf("cat > \"$LIB/bridge.py\" <<'PY'\n");
const tail = sh.slice(sh.indexOf("\n", start) + 1);
const bridge = tail.slice(0, tail.indexOf("\nPY\n"))
  .replace("return a.is_global and not a.is_multicast", "return a.is_loopback")
  .replace("loop.getaddrinfo(host,", "loop.getaddrinfo(\"127.0.0.1\" if host == \"localhost.example.org\" else host,");

const hasWs = spawnSync("python3", ["-c", "import websockets"]).status === 0;

const DRIVER = String.raw`
import asyncio, json, os, subprocess, sys, time, socket
import websockets
bridge, secret, revoked, auth = sys.argv[1:5]
sys.path.insert(0, os.path.dirname(bridge))
import importlib.util
spec = importlib.util.spec_from_file_location("bridge", bridge); b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
key = b.load_secret(secret)
s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
env = dict(os.environ, AUTH=auth, SECRET_FILE=secret, REVOKED_FILE=revoked, ALLOW_HOSTS="localhost.example.org", LISTEN_PORT=str(port))
p = subprocess.Popen([sys.executable, bridge], env=env)
out = {}
async def try_tok(tok, protos=None):
    if protos is None:
        protos = ["velta.v1"] + (["tok." + tok] if tok is not None else [])
    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/dns/localhost.example.org", subprotocols=protos or None, open_timeout=5) as ws:
            return {"ok": True, "proto": ws.subprotocol, "msg": json.loads(await ws.recv())}
    except Exception as e:
        st = getattr(getattr(e, "response", None), "status_code", None) or getattr(e, "status_code", None)
        return {"ok": False, "status": st}
async def main():
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close(); break
        except OSError:
            await asyncio.sleep(0.05)
    if auth == "0":
        out["plain"] = await try_tok(None, [])
        out["offered"] = await try_tok("whatever")
        return
    out["valid"] = await try_tok(b.mint(key, "aaa111", "Ann", time.time() + 3600))
    out["noexp"] = await try_tok(b.mint(key, "bbb222"))
    out["badsig"] = await try_tok(b.mint(b"x" * 64, "aaa111"))
    good = b.mint(key, "aaa111")
    out["tampered"] = await try_tok(b.b64e(b'{"v":1,"i":"zzz999"}') + "." + good.split(".")[1])
    out["expired"] = await try_tok(b.mint(key, "ccc333", "", time.time() - 5))
    out["missing"] = await try_tok(None)
    out["garbage"] = await try_tok("not-a-token")
    with open(revoked, "a") as f: f.write("aaa111\n")
    await asyncio.sleep(2.3)
    out["revoked"] = await try_tok(b.mint(key, "aaa111", "Ann"))
    out["other_ok"] = await try_tok(b.mint(key, "bbb222"))
try:
    asyncio.run(main())
finally:
    p.kill()
print(json.dumps(out))
`;

test("bridge enforces invite tokens at the handshake", { skip: !hasWs && "python3 websockets missing" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "velta-wsauth-"));
  const bridgePath = join(dir, "bridge.py");
  writeFileSync(bridgePath, bridge);
  writeFileSync(join(dir, "secret"), "ab".repeat(32) + "\n");
  writeFileSync(join(dir, "revoked"), "# revoked invite ids\n");
  const r = spawnSync("python3", ["-c", DRIVER, bridgePath, join(dir, "secret"), join(dir, "revoked"), "1"], { encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.deepEqual(out.valid, { ok: true, proto: "velta.v1", msg: ["127.0.0.1"] });
  assert.equal(out.noexp.ok, true);
  for (const k of ["badsig", "tampered", "expired", "missing", "garbage", "revoked"]) {
    assert.deepEqual(out[k], { ok: false, status: 401 }, k);
  }
  assert.equal(out.other_ok.ok, true, "revoking one id leaves others working");
});

test("--mint prints a velta://ws link the app accepts", { skip: !hasWs && "python3 websockets missing" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "velta-wsauth-"));
  writeFileSync(join(dir, "bridge.py"), bridge);
  writeFileSync(join(dir, "secret"), "cd".repeat(32));
  const r = spawnSync("python3", [join(dir, "bridge.py"), "--mint", "--secret", join(dir, "secret"), "--log", join(dir, "inv.tsv"),
    "--name", "Mum & Dad", "--expires", "30d", "--url", "wss://proxy.example.org"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const link = r.stdout.trim();
  const { parseWsLink } = await import("../app/js/ws-transport.js");
  const p = parseWsLink(link);
  assert.equal(p.url, "wss://proxy.example.org");
  assert.equal(p.label, "Mum & Dad");
  assert.match(p.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  const id = /invite id: ([0-9a-f]{12})/.exec(r.stderr)[1];
  assert.match(readFileSync(join(dir, "inv.tsv"), "utf8"), new RegExp(`^${id}\tMum & Dad\t\\d+\n$`));
  const l = spawnSync("python3", [join(dir, "bridge.py"), "--list-invites", "--secret", join(dir, "secret"), "--log", join(dir, "inv.tsv"), "--revoked", join(dir, "nope")], { encoding: "utf8" });
  assert.match(l.stdout, new RegExp(`${id}\tMum & Dad\t\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\tactive`));
});

test("--no-auth bridge still serves clients with and without a subprotocol", { skip: !hasWs && "python3 websockets missing" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "velta-wsauth-"));
  writeFileSync(join(dir, "bridge.py"), bridge);
  writeFileSync(join(dir, "secret"), "ab".repeat(32));
  const r = spawnSync("python3", ["-c", DRIVER, join(dir, "bridge.py"), join(dir, "secret"), join(dir, "revoked"), "0"], { encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.deepEqual(out.plain, { ok: true, proto: null, msg: ["127.0.0.1"] });
  assert.deepEqual(out.offered, { ok: true, proto: "velta.v1", msg: ["127.0.0.1"] });
});
