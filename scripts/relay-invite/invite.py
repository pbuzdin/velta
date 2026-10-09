#!/usr/local/lib/chatmaild/venv/bin/python3
"""Invite-gated account minting (PLAN-PWA-WEBSOCKET R1, v1 — simplified).

GET  /i/<token>  interstitial page: explains the relay, links the same-origin
                 PWA (`/app/index.html#/join?t=<token>`).
GET  /i/claim?t=…  consumes the invite atomically (single-use, flock'd) and
                 answers {"email","password"} — same generator as the old
                 /new. GET because fcgiwrap chokes on request bodies here;
                 the token already rides URLs by design, credentials never do.

Store: /var/lib/velta-invites/invites.json (0640 root:www-data) —
sha256(token) → {"uses": n, "expires": epoch|0, "revoked": bool,
"note": str, "claimed": [addr…]}. Admin CLI: /root/relay/invite-tool.py.

chisle: JSON+flock store is plenty at friends-and-family volume; move to
SQLite only if invite bookkeeping ever outgrows it. The invite token rides
the URLs in clear (it IS the bearer secret, like the invite link itself);
upgrade to AEAD claim tickets if invites ever become long-lived-sensitive.
Credentials never touch URLs or logs — only the claim answer carries them.
"""
import fcntl
import hashlib
import html
import json
import os
import sys
import time
from urllib.parse import parse_qs

sys.path.insert(0, "/usr/lib/cgi-bin")
from chatmaild.config import read_config
from newemail import create_newemail_dict

CONFIG_PATH = "/usr/local/lib/chatmaild/chatmail.ini"
STORE = "/var/lib/velta-invites/invites.json"
PWA_JOIN = "/app/index.html#/join?t="


def respond(status, ctype, body, extra_headers=""):
    print(f"Status: {status}")
    print(f"Content-Type: {ctype}")
    if extra_headers:
        print(extra_headers)
    print()
    print(body)


def respond_json(status, obj, no_store=False):
    # no-store on claim answers: a cached 200 would double-mint on back-nav.
    respond(status, "application/json", json.dumps(obj),
            "Cache-Control: no-store" if no_store else "")


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def read_store():
    try:
        with open(STORE, "r") as f:
            fcntl.flock(f, fcntl.LOCK_SH)
            raw = f.read()
        return json.loads(raw) if raw.strip() else {"invites": {}}
    except FileNotFoundError:
        return {"invites": {}}


def claim(token):
    """Consume one use atomically; mint credentials on success."""
    h = token_hash(token)
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    with open(STORE, "a+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        raw = f.read()
        data = json.loads(raw) if raw.strip() else {"invites": {}}
        inv = data["invites"].get(h)
        now = int(time.time())
        if inv is None or inv.get("revoked"):
            return 403, {"error": "This invite is not valid."}
        if inv.get("expires") and inv["expires"] < now:
            return 410, {"error": "This invite has expired."}
        if inv.get("uses", 1) <= 0:
            return 409, {"error": "This invite has already been used up."}
        creds = create_newemail_dict(read_config(CONFIG_PATH))
        inv["uses"] = inv.get("uses", 1) - 1
        inv.setdefault("claimed", []).append(creds["email"])
        f.seek(0)
        f.truncate()
        json.dump(data, f, indent=1)
    return 200, {"email": creds["email"], "password": creds["password"]}


def invite_state(token):
    inv = read_store()["invites"].get(token_hash(token))
    if inv is None or inv.get("revoked"):
        return "invalid", inv
    if inv.get("expires") and inv["expires"] < int(time.time()):
        return "expired", inv
    if inv.get("uses", 1) <= 0:
        return "used", inv
    return "valid", inv


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invitation — {domain}</title>
<style>
body {{ background:#0f0f14; color:#e8e8f0; font:16px/1.6 system-ui,sans-serif;
       display:flex; min-height:100vh; margin:0; }}
main {{ max-width:34rem; margin:auto; padding:2rem; }}
h1 {{ font-size:1.4rem; }} code {{ color:#9fb4ff; }}
a.btn {{ display:inline-block; margin-top:1rem; padding:.8em 1.6em;
        background:#4f6df5; color:#fff; border-radius:10px;
        text-decoration:none; font-weight:600; }}
p.small {{ color:#9a9aac; font-size:.85rem; }}
</style></head><body><main>
<h1>You're invited to <code>{domain}</code></h1>
{body}
<p class="small">Instant end-to-end encrypted chat — no email, no phone
number, no password. An account will be created for you; keep the app's
backup safe, the operator cannot recover it.</p>
</main></body></html>"""


def interstitial(token):
    state, inv = invite_state(token)
    config = read_config(CONFIG_PATH)
    domain = config.mail_domain
    if state != "valid":
        msg = {
            "invalid": "This invite is not valid.",
            "expired": "This invite has expired.",
            "used": "This invite has already been used up.",
        }[state]
        body = f"<p>{msg}</p><p class='small'>Ask the operator for a fresh link.</p>"
        return respond(200, "text/html; charset=utf-8",
                       PAGE.format(domain=html.escape(domain), body=body))
    dclogin_note = ""
    body = f"""
<p>{html.escape(inv.get("note") or "A private chatmail relay for end-to-end encrypted messaging.")}</p>
<p><a class="btn" href="{PWA_JOIN}{html.escape(token, quote=True)}">Continue — set up your profile</a></p>
<p class="small">Opens the Velta web app on this relay. Uses {inv.get("uses", 1)} of your invite remaining.</p>{dclogin_note}"""
    return respond(200, "text/html; charset=utf-8",
                   PAGE.format(domain=html.escape(domain), body=body))


def main():
    # fcgiwrap chokes on request BODIES here (POST → 502, root cause not
    # worth chasing on a box with flapping access) — so the claim is a GET
    # with the token in the query string. The token already rides URLs by
    # design (it IS the invite link); credentials only ever ride the
    # no-store TLS answer.
    path = os.environ.get("PATH_INFO") or os.environ.get("REQUEST_URI", "") or ""
    path = path.split("?", 1)[0]
    token = path.rstrip("/").rsplit("/", 1)[-1]
    if token == "claim":
        query = os.environ.get("QUERY_STRING", "")
        invite = parse_qs(query).get("t", [""])[0].strip()
        if not invite:
            return respond_json(400, {"error": "Missing invite token."}, no_store=True)
        status, body = claim(invite)
        return respond_json(status, body, no_store=True)
    if token:
        return interstitial(token)
    respond_json(404, {"error": "Not found."})


if __name__ == "__main__":
    main()
