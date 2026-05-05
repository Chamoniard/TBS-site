#!/bin/bash
# Double-click this file in Finder to serve the site (macOS).
cd "$(dirname "$0")" || exit 1
PORT=8080
echo ""
echo "  Site:  http://127.0.0.1:${PORT}/"
echo "  Stop:  press Ctrl+C in this window"
echo ""
python3 -m http.server "$PORT"
