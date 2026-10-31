"""PROTOTYPE. Serves a built pi-on-gfs web app on localhost with the headers it needs.

The WASIX runtime needs SharedArrayBuffer, so the page must be cross-origin isolated:
Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.

    python3 serve.py <dist dir> [port]
"""
import functools
import http.server
import sys

root = sys.argv[1]
port = int(sys.argv[2]) if len(sys.argv) > 2 else 4173


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".webc": "application/octet-stream",
    }

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=root))
print(f"pi on gfs (with the WayQuest view): http://127.0.0.1:{port}/", flush=True)
print("Ctrl-C to stop. Everything you do is stored in this browser (OPFS).", flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
