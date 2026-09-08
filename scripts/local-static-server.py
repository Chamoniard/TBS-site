#!/usr/bin/env python3
"""Threaded local static file server (avoids wedging on one blocked request)."""
from __future__ import annotations

import argparse
import os
import socket
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class DualStackThreadingServer(ThreadingHTTPServer):
    """Prefer IPv6 dual-stack so both localhost and 127.0.0.1 work on macOS."""

    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument(
        "--directory",
        default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        help="Site root to serve",
    )
    args = parser.parse_args()
    root = os.path.abspath(args.directory)
    os.chdir(root)
    handler = partial(SimpleHTTPRequestHandler, directory=root)

    try:
        httpd = DualStackThreadingServer(("::", args.port), handler)
        bind_note = "http://localhost:{0}/ and http://127.0.0.1:{0}/".format(args.port)
    except OSError:
        httpd = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
        bind_note = "http://127.0.0.1:{0}/".format(args.port)

    print("Serving (threaded) from:")
    print(" ", root)
    print("Open:")
    print(" ", bind_note)
    print("Login:")
    print("  http://localhost:{0}/login.html".format(args.port))
    print("(Use localhost for Firebase Google sign-in.)")
    print("Stop: Ctrl+C")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
