#!/usr/bin/env python3
"""Sign self-contained Velta PWA onboarding invites (v2).

Veltar supplies its existing HMAC proxy token and private deployment values.
Only the Ed25519 public verification key is added to the PWA build.
"""
import argparse
import base64
import json
import os
import re
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")
HOST_RE = re.compile(r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{43}$")


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(value):
    return base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))


def public_key(private_key, key_id):
    if not ID_RE.fullmatch(key_id):
        raise ValueError("bad onboarding key id")
    raw = private_key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return key_id + "=" + b64url(raw)


def _proxy_url(value):
    url = urlsplit(value)
    if url.scheme != "wss" or not url.hostname or url.username or url.password:
        raise ValueError("proxy must be a wss URL")
    if url.port or url.query or url.fragment:
        raise ValueError("proxy cannot have a custom port, query or fragment")
    return value


def _relays(values):
    relays = {}
    for relay_id, host in values.items():
        host = host.strip().lower().rstrip(".")
        if not ID_RE.fullmatch(relay_id) or not HOST_RE.fullmatch(host) or "." not in host:
            raise ValueError("bad onboarding relay")
        if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", host):
            raise ValueError("onboarding relays must be DNS names")
        relays[relay_id] = host
    if not relays:
        raise ValueError("at least one onboarding relay is required")
    return relays


def mint_pwa_invite(token, proxy, relays, private_key, key_id, pwa_url):
    """Return a v2 URL; private_key is an Ed25519 private-key object."""
    if not TOKEN_RE.fullmatch(token):
        raise ValueError("bad HMAC proxy token")
    token_payload = json.loads(b64url_decode(token.split(".", 1)[0]))
    if token_payload.get("v") != 1:
        raise ValueError("unsupported proxy token")
    expiry = token_payload.get("e", 0)
    if not isinstance(expiry, int) or isinstance(expiry, bool) or expiry < 0:
        raise ValueError("bad proxy-token expiry")
    target = urlsplit(pwa_url)
    if target.scheme != "https" or not target.hostname or target.query or target.fragment:
        raise ValueError("PWA URL must be an HTTPS URL without query or fragment")
    payload = {
        "v": 2,
        "t": token,
        "p": _proxy_url(proxy),
        "r": _relays(relays),
        "e": expiry,
        "k": key_id,
    }
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    envelope = b64url(raw) + "." + b64url(private_key.sign(raw))
    return pwa_url + "?" + urlencode({"invite": envelope})


def load_private_key(path):
    with open(path, "rb") as handle:
        key = serialization.load_pem_private_key(handle.read(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("onboarding key must be Ed25519")
    return key


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("keygen", "public"):
        cmd = sub.add_parser(name)
        cmd.add_argument("key_id")
        cmd.add_argument("--private-key", required=True)
    mint = sub.add_parser("mint")
    mint.add_argument("--private-key", required=True)
    mint.add_argument("--key-id", required=True)
    mint.add_argument("--token", required=True)
    mint.add_argument("--proxy", required=True)
    mint.add_argument("--relay", action="append", required=True, metavar="ID=HOST")
    mint.add_argument("--pwa-url", required=True)
    args = parser.parse_args()

    if args.command == "keygen":
        path = Path(args.private_key)
        if path.exists():
            parser.error("private key already exists")
        key = Ed25519PrivateKey.generate()
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "xb") as handle:
            os.chmod(path, 0o600)
            handle.write(key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ))
        print(public_key(key, args.key_id))
        return

    key = load_private_key(args.private_key)
    if args.command == "public":
        print(public_key(key, args.key_id))
        return
    relays = dict(item.split("=", 1) for item in args.relay)
    print(mint_pwa_invite(
        args.token, args.proxy, relays, key, args.key_id, args.pwa_url
    ))


if __name__ == "__main__":
    main()
