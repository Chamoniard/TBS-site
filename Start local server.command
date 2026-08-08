#!/bin/bash
# Double-click this file in Finder to serve the site (macOS).
cd "$(dirname "$0")" || exit 1
PORT=8080
echo ""
# Node static server — Python http.server keeps wedging on this iCloud path.
exec node scripts/local-static-server.mjs --port="$PORT"
