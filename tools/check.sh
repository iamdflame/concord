#!/usr/bin/env bash
# Everything CI would run, runnable by anyone with the repository.
#
# It exists because CI is not a substitute for being able to check the project
# yourself, and because Actions is currently unavailable on this account.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── the protocol, no browser ──────────────────────"
npm test 2>&1 | grep -E "^# (tests|pass|fail)|^ℹ (tests|pass|fail)" || true

echo ""
echo "── the published verifier matches this repository ─"
node verify/build.mjs >/dev/null
git diff --quiet verify/lib && echo "  ✓ verify/lib is current" \
  || { echo "  ✗ verify/lib is stale — commit the regenerated files"; exit 1; }

echo ""
echo "── against real origins ──────────────────────────"
node server.mjs >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
until curl -sf -o /dev/null http://localhost:5181/; do sleep 0.3; done

for page in "" phase02.html phase03.html phase04.html concord-test.html conformance.html; do
  printf '  %-20s ' "${page:-phase01}"
  URL="http://localhost:5173/$page" node tools/probe.mjs 2>&1 | grep -oE '(PHASE [0-9]+ |CONCORD )?(PASSED|FAILED)|^PASS|^FAIL' | head -1
done

echo ""
echo "── the live deployment ───────────────────────────"
node deploy/verify-live.mjs 2>&1 | tail -1
