#!/usr/bin/env bash
# Re-apply dsh-client's harness patches after a harness git pull / checkout.
# Usage: bash apply-patches.sh [harness-dir]   (default: ../deepseek-harness)
set -e
HARNESS="${1:-$(dirname "$0")/../../deepseek-harness}"
cd "$HARNESS"
if git apply --check "$(dirname "$0")/sdk-server.patch" 2>/dev/null; then
  git apply "$(dirname "$0")/sdk-server.patch"
  echo "patched sdk-server"
else
  echo "sdk-server.patch does not apply cleanly (already applied, or upstream changed); inspect manually:"
  git apply --reject "$(dirname "$0")/sdk-server.patch" || true
fi
echo "done — run 'pnpm install && pnpm run build' in $HARNESS to rebuild artifacts"
