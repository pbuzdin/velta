#!/usr/bin/python3
"""Admin CLI for invite-gated account creation (PLAN-PWA-WEBSOCKET R1).

  invite-tool.py add [uses] [days] [note]   mint; prints the invite URL
  invite-tool.py list                       show invites + claim counts
  invite-tool.py revoke <token-or-url>      revoke (hash matched server-side)

Store: /var/lib/velta-invites/invites.json — sha256(token) keys, so the raw
token exists only in the printed link (and this tool's stdin history).
Run as root (store is root:www-data 0640 — the claim CGI only needs read).
"""
import hashlib
import json
import os
import secrets
import sys
import time

STORE = "/var/lib/velta-invites/invites.json"


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def load():
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    try:
        with open(STORE) as f:
            raw = f.read()
        return json.loads(raw) if raw.strip() else {"invites": {}}
    except FileNotFoundError:
        return {"invites": {}}


def save(data):
    tmp = STORE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    # root:www-data 0660 — the claim CGI (www-data) must READ and WRITE
    # (single-use decrement). os.replace would otherwise flip the file to
    # root:root after every mint and 502 every later claim.
    st = os.stat(os.path.dirname(STORE))
    os.chown(tmp, 0, st.st_gid)
    os.chmod(tmp, 0o660)
    os.replace(tmp, STORE)


def domain():
    # chatmail.ini is TOML-ish (bare top-level keys) — regex the one key we
    # need instead of pulling in a parser or the chatmaild venv
    import re
    text = open("/usr/local/lib/chatmaild/chatmail.ini").read()
    m = re.search(r'^mail_domain\s*=\s*["\']?([^"\'\n#]+)', text, re.M)
    return m.group(1).strip() if m else ""


def extract_token(arg):
    arg = arg.strip().rstrip("/")
    return arg.rsplit("/", 1)[-1]


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    data = load()
    if cmd == "add":
        uses = int(sys.argv[2]) if len(sys.argv) > 2 else 1
        days = int(sys.argv[3]) if len(sys.argv) > 3 else 0
        note = sys.argv[4] if len(sys.argv) > 4 else ""
        token = secrets.token_urlsafe(18)
        data["invites"][token_hash(token)] = {
            "uses": uses,
            "expires": int(time.time()) + days * 86400 if days else 0,
            "revoked": False,
            "note": note,
            "created": int(time.time()),
        }
        save(data)
        print(f"https://{domain()}/i/{token}")
    elif cmd == "list":
        now = int(time.time())
        for h, inv in data["invites"].items():
            state = "revoked" if inv.get("revoked") else (
                "expired" if inv.get("expires") and inv["expires"] < now else
                "used up" if inv.get("uses", 1) <= 0 else f"{inv.get('uses', 1)} left")
            claimed = ", ".join(inv.get("claimed", [])) or "-"
            print(f"{h[:8]}…  {state:<9} {inv.get('note', ''):<20} claimed: {claimed}")
    elif cmd == "revoke":
        if len(sys.argv) < 3:
            sys.exit("usage: invite-tool.py revoke <token-or-invite-url>")
        h = token_hash(extract_token(sys.argv[2]))
        if h in data["invites"]:
            data["invites"][h]["revoked"] = True
            save(data)
            print("revoked")
        else:
            sys.exit("no such invite")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
