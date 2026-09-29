#!/usr/bin/env bash
# End-to-end test: serves a copy of deckbuilder/ with the fixture collection on port 8765 and
# drives it in headless Chromium (tests/e2e.js). Reuses the app's card database and EDHREC cache
# when present so it doesn't download them again. Needs Node 18+ and network access.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
app=$here/../deckbuilder
tmp=$(mktemp -d)
pid=
trap '[ -n "$pid" ] && kill $pid 2>/dev/null; rm -rf "$tmp"' EXIT
cp -r "$app"/{index.html,style.css,server.py,js} "$here/fixtures/Cards.txt" "$tmp"/
[ -e "$app/cards-db-v4.json" ] && ln -s "$app/cards-db-v4.json" "$tmp"/
[ -d "$app/edhrec-cache" ] && cp -r "$app/edhrec-cache" "$tmp"/
python3 "$tmp/server.py" 8765 > "$tmp/server.log" 2>&1 &
pid=$!
until curl -sf localhost:8765/decks.json > /dev/null; do  # loads (or downloads) the database first
  kill -0 $pid 2>/dev/null || { cat "$tmp/server.log"; exit 1; }
  sleep 1
done
cd "$here"
[ -d node_modules ] || npm install --silent
[ -d ~/.cache/ms-playwright ] || npx playwright install chromium
node e2e.js || { tail -20 "$tmp/server.log"; ls "$tmp"; exit 1; }
