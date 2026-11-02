#!/usr/bin/env python3
"""Behavioral regression for the chat-open freeze (#176).

Runs the REAL deltachat-rpc-server built from Velta's patched core. One
account's IMAP/SMTP point at a local blackhole (accepts TCP, never sends a
greeting), so IO tasks hang in their connect/greeting read and stop_io winds
them down only on the scheduler's 30 s shutdown timeout. While that stop is
in progress the chat-open RPCs (get_basic_chat_info, get_message_ids,
get_chatlist_items_by_entries, ...) must still answer in < 1 s.

Usage: stop_io_stall.py PATH/TO/deltachat-rpc-server
Exit 0 = pass, 1 = a read RPC blocked behind the IO stop, 2 = harness could
not reproduce the stalled stop (inconclusive, treated as failure in CI).
"""
import json, os, socket, sqlite3, subprocess, sys, tempfile, threading, time

READ_LIMIT_S = 1.0
MIN_STALL_S = 5.0


class Blackhole:
    def __init__(self, greet=b"", socks=False):
        self.greet = greet
        self.socks = socks
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(64)
        self.port = self.sock.getsockname()[1]
        self.conns = []
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while True:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            self.conns.append(c)
            if self.socks:
                threading.Thread(target=self._socks, args=(c,), daemon=True).start()
                continue
            if self.greet:
                try:
                    c.sendall(self.greet)  # then never answer again
                except OSError:
                    pass


    @staticmethod
    def _socks(c):
        """A dead DNS tunnel: SOCKS5 greeting/auth succeed, CONNECT never answers."""
        try:
            hdr = c.recv(2)
            c.recv(hdr[1])
            c.sendall(b"\x05\x02" if True else b"")  # user/pass auth
            sub = c.recv(2)
            c.recv(sub[1])
            plen = c.recv(1)[0]
            c.recv(plen)
            c.sendall(b"\x01\x00")  # auth ok
            c.recv(512)  # CONNECT request: never answered
        except (OSError, IndexError):
            pass


class Rpc:
    def __init__(self, binary, accounts_dir):
        env = dict(os.environ, DC_ACCOUNTS_PATH=accounts_dir, RUST_LOG="error")
        env.pop("VELTA_DB_KEY", None)
        if os.environ.get("STALL_MODE", "hook") == "hook":
            # Core patch #21 test hook: Scheduler::stop takes 8 s, like
            # IMAP/SMTP tasks winding down over a dead proxy in the field.
            env["VELTA_TEST_STOP_IO_DELAY_MS"] = "8000"
        self.p = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env=env, text=True, bufsize=1)
        self.next_id = 0
        self.waiters = {}
        self.lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            w = self.waiters.pop(msg.get("id"), None)
            if w:
                w[1].update(msg)
                w[0].set()

    def call_async(self, method, *params):
        with self.lock:
            self.next_id += 1
            rid = self.next_id
            ev, box = threading.Event(), {}
            self.waiters[rid] = (ev, box)
            self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": list(params)}) + "\n")
            self.p.stdin.flush()
        started = time.monotonic()

        def wait(timeout=120):
            if not ev.wait(timeout):
                raise TimeoutError(f"{method}: no answer in {timeout}s")
            if "error" in box:
                raise RuntimeError(f"{method}: {box['error']}")
            return box.get("result"), time.monotonic() - started
        return wait

    def call(self, method, *params, timeout=120):
        return self.call_async(method, *params)(timeout)[0]

    def close(self):
        self.p.stdin.close()
        try:
            self.p.wait(10)
        except subprocess.TimeoutExpired:
            self.p.kill()


def blackhole_transport(db, addr, port):
    srv = {"connection": {"host": "127.0.0.1", "port": port, "security": "Plain"}, "user": "u"}
    entered_srv = {"server": "", "port": 0, "security": "Automatic", "user": "", "password": ""}
    entered = {"addr": addr, "imap": dict(entered_srv, folder=""), "smtp": entered_srv,
               "certificate_checks": "Automatic", "oauth2": False}
    configured = {"addr": addr, "imap": [srv], "imap_user": "u", "imap_password": "p",
                  "smtp": [srv], "smtp_user": "u", "smtp_password": "p",
                  "certificate_checks": "AcceptInvalidCertificates", "oauth2": False}
    con = sqlite3.connect(db)
    con.execute("INSERT INTO transports (addr, entered_param, configured_param) VALUES (?,?,?)",
                (addr, json.dumps(entered), json.dumps(configured)))
    for k, v in (("configured_addr", addr), ("configured", "1"), ("addr", addr)):
        con.execute("INSERT OR REPLACE INTO config (keyname, value) VALUES (?,?)", (k, v))
    con.commit()
    con.close()


def main(binary):
    mode = os.environ.get("STALL_MODE", "hook")
    hole = Blackhole(b"* OK IMAP4rev1 ready\r\n" if mode == "greet" else b"", socks=mode == "deadtunnel")
    root = tempfile.mkdtemp(prefix="velta-stall-")
    rpc = Rpc(binary, root)
    acc = rpc.call("add_account")
    rpc.close()
    dbs = [os.path.join(dp, f) for dp, _, fs in os.walk(root) for f in fs if f == "dc.db"]
    assert len(dbs) == 1, dbs
    blackhole_transport(dbs[0], "stall@example.org", hole.port)

    rpc = Rpc(binary, root)
    assert rpc.call("is_configured", acc), "pseudo transport not accepted as configured"
    chat = rpc.call("create_chat_by_contact_id", acc, 1)  # saved messages
    if mode == "deadtunnel":
        # Saved-but-dead DNS tunnel (Velta writes socks5://velta-tunnel:…@127.0.0.1:N).
        rpc.call("set_config", acc, "proxy_url", f"socks5://velta-tunnel:pw@127.0.0.1:{hole.port}")
        rpc.call("set_config", acc, "proxy_enabled", "1")
    if mode == "proxy":
        # Dead SOCKS5 proxy (the field case): TCP accepted, no handshake.
        rpc.call("set_config", acc, "proxy_url", f"socks5://127.0.0.1:{hole.port}")
        rpc.call("set_config", acc, "proxy_enabled", "1")
    rpc.call("start_io_for_all_accounts")
    time.sleep(3)  # IO tasks now sit on the blackhole
    print(f"blackhole holds {len(hole.conns)} connection(s)")

    stop = rpc.call_async("stop_io_for_all_accounts")
    time.sleep(0.3)  # the scheduler lock is held by the stop
    # A restart queued behind the stop (UI resume, reconnect) must not
    # freeze the reads either (it used to wait holding accounts.write()).
    restart = rpc.call_async("start_io_for_all_accounts")
    time.sleep(0.2)
    reads = [
        ("get_basic_chat_info", acc, chat),
        ("get_message_ids", acc, chat, False, False),
        ("get_chatlist_entries", acc, None, None, None),
        ("get_chatlist_items_by_entries", acc, [chat]),
        ("get_fresh_msg_cnt", acc, chat),
        ("get_connectivity", acc),
        ("maybe_network",),
    ]
    failures = []
    waits = [(m, rpc.call_async(m, *params)) for m, *params in reads]  # all at once
    for m, wait in waits:
        try:
            _, took = wait(timeout=60)
        except Exception as e:  # noqa: BLE001
            failures.append(f"{m}: {e}")
            continue
        verdict = "ok" if took < READ_LIMIT_S else "BLOCKED"
        print(f"{m:32s} {took * 1000:8.0f} ms  {verdict}")
        if took >= READ_LIMIT_S:
            failures.append(f"{m} took {took:.1f}s")
    _, stop_took = stop(timeout=180)
    print(f"stop_io_for_all_accounts took {stop_took:.1f}s")
    restart(timeout=180)

    # Android resume cancels work started while hidden before refreshing chats.
    # Exercise the real core API: a blackhole fetch must end on cancellation,
    # and the first foreground read must not queue behind it (#185).
    fetch = rpc.call_async("background_fetch", 60.0)
    time.sleep(1)
    try:
        fetch(timeout=0)
        rpc.close()
        print("INCONCLUSIVE: background_fetch finished before cancellation")
        return 2
    except TimeoutError:
        pass
    cancel_started = time.monotonic()
    rpc.call("stop_background_fetch", timeout=5)
    fetch(timeout=5)
    cancel_took = time.monotonic() - cancel_started
    print(f"background_fetch cancellation took {cancel_took * 1000:.0f} ms")
    if cancel_took >= READ_LIMIT_S:
        failures.append(f"background_fetch cancellation took {cancel_took:.1f}s")
    read = rpc.call_async("get_basic_chat_info", acc, chat)
    _, read_took = read(timeout=5)
    print(f"post-cancel chat read took {read_took * 1000:.0f} ms")
    if read_took >= READ_LIMIT_S:
        failures.append(f"post-cancel chat read took {read_took:.1f}s")
    rpc.close()
    if failures:
        print("FAIL:", "; ".join(failures))
        return 1
    if stop_took < MIN_STALL_S:
        print(f"INCONCLUSIVE: stop_io did not stall ({stop_took:.1f}s < {MIN_STALL_S}s)")
        return 2
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
