#!/usr/bin/env python3
"""Dev server for web/: like `python3 -m http.server`, but sends Cache-Control: no-store so a
normal reload always picks up edited JS/CSS (plain http.server lets browsers reuse stale copies).

Usage: python3 scripts/serve.py [port]   # default 8000, serves ./web on 127.0.0.1
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    web = Path(__file__).resolve().parent.parent / "web"
    handler = partial(NoCacheHandler, directory=str(web))
    print(f"Serving {web} at http://127.0.0.1:{port}/ (no caching)")
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
