#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_DIR="$ROOT_DIR/public"
OUT_DIR="$ROOT_DIR/tmp/responsive"
URL_BASE="http://localhost:4173/access-beppu-map.html"
WIDTHS=(1440 1433 1280 1200 1100 1000 979)
HEIGHT=900

mkdir -p "$OUT_DIR"

server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" >/dev/null 2>&1; then
    kill "$server_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Start local server only if not already running.
if ! curl -fsS "$URL_BASE" >/dev/null 2>&1; then
  (
    cd "$PUBLIC_DIR"
    python3 -m http.server 4173 >/dev/null 2>&1
  ) &
  server_pid=$!
  sleep 1
fi

for w in "${WIDTHS[@]}"; do
  npx --yes playwright screenshot \
    --browser=chromium \
    --viewport-size="${w},${HEIGHT}" \
    "$URL_BASE" \
    "$OUT_DIR/${w}.png"
done

echo "Saved screenshots:"
ls -1 "$OUT_DIR"/*.png
