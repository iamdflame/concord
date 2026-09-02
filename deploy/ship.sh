#!/usr/bin/env bash
# Deploy every origin, with its signing key already in place.
#
# A vendor that generates its own key on a serverless host publishes one key and
# signs with another, so every receipt fails to verify -- quietly, and only for
# whoever tries to check one later. The secret goes in before the deployment.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

KEYS="${1:?usage: deploy/ship.sh path/to/keys.env}"
node deploy/build.mjs

# The coordinator cannot be "concord-app": that subdomain belongs to someone
# else, and Vercel quietly deploys elsewhere rather than failing.
# The project name is not always the vendor id: "concord-app" belongs to
# somebody else, and Meridian deploys under its own name because a URL reading
# "shady" would tell the audience the twist before the demo does.
project_for() {
  case "$1" in
    app)   echo "concord-coordinator" ;;
    shady) echo "concord-meridian" ;;
    byo)   echo "concord-sandbox" ;;
    verify) echo "concord-receipts" ;;
    *)     echo "concord-$1" ;;
  esac
}

for dir in .deploy/concord-*; do
  id="${dir##*/concord-}"
  UP="$(echo "$id" | tr a-z A-Z)"
  PROJECT="$(project_for "$id")"
  echo ""
  echo "── $id → $PROJECT ──────────────────────────"
  ( cd "$ROOT/$dir"
    # Not swallowed. A failed link silently deploys into whatever project the
    # directory name happens to match, which is how two origins ended up as one.
    vercel link --yes --project "$PROJECT" >/dev/null

    if [ "$id" != "app" ] && [ "$id" != "verify" ]; then
      key="$(grep -m1 "^CONCORD_KEY_${UP}=" "$KEYS" | cut -d= -f2-)"
      vercel env rm "CONCORD_KEY_${UP}" production --yes >/dev/null 2>&1 || true
      printf '%s' "$key" | vercel env add "CONCORD_KEY_${UP}" production >/dev/null 2>&1
      echo "  key set"
    fi

    vercel deploy --prod --yes >/dev/null 2>&1
    echo "  deployed"
  )
done

echo ""
echo "── verifying ─────────────────────────────────"
node "$ROOT/deploy/verify-live.mjs"
