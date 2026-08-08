#!/usr/bin/env bash
# Build a lean static tree for Firebase Hosting (avoids scanning .git / node_modules).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rm -rf _site
mkdir -p _site
rsync -a \
  --exclude '.git/' \
  --exclude '.github/' \
  --exclude '_site/' \
  --exclude 'node_modules/' \
  --exclude 'functions/' \
  --exclude 'scripts/' \
  --exclude 'data/' \
  --exclude 'firebase-debug.log' \
  --exclude 'firebase-debug.*.log' \
  --exclude 'firebase.json' \
  --exclude '.firebaserc' \
  --exclude 'package.json' \
  --exclude 'package-lock.json' \
  --exclude 'storage.rules' \
  --exclude 'firestore.rules.example' \
  --exclude 'blog-website.code-workspace' \
  --exclude '*.bak' \
  --exclude '*.md' \
  ./ _site/
if [ -f CNAME ]; then
  cp CNAME _site/CNAME
fi
echo "Prepared _site ($(find _site -type f | wc -l | tr -d ' ') files)"
