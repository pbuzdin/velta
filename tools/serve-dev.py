#!/usr/bin/env python3
"""Dev static server for app/ — like `python -m http.server` but sends
Cache-Control: no-store, so a plain browser reload always picks up edited
sources instead of serving them from the HTTP heuristic cache. (Released
apps get fresh assets via the service-worker CACHE bump; this server covers
the no-SW dev case.)

Usage: python tools/serve-dev.py [port]   (serves the app/ directory)
"""
import http.server
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.normpath(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8747
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
