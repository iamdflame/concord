#!/usr/bin/env bash
# Rasterise the README banner. Chrome, because it is already a dependency of
# the test harness and it renders the same engine the site is designed against.
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-google-chrome}"
for theme in light dark; do
  OUT="brand/concord-banner$([ "$theme" = dark ] && echo -dark).png"
  BODY=$([ "$theme" = dark ] && echo 'document.body.className="dark";document.getElementById("mark").src="concord-mark-dark.svg";' || echo '')
  "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --force-device-scale-factor=2 --window-size=1280,440 \
    --virtual-time-budget=4000 --default-background-color=00000000 \
    --screenshot="$OUT" "brand/banner.html?$theme" >/dev/null 2>&1 || true
  echo "  $OUT"
done
