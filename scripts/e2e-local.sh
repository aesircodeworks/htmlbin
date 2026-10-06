#!/usr/bin/env bash
# Boot a throwaway local Worker and run agent-e2e.sh against it.
#
# Self-contained: fresh D1/KV state under .wrangler/e2e/, a random
# TOKEN_PEPPER, and the GitHub "dev-mock" sentinel. Used by CI and safe to
# run locally (it never touches your normal .wrangler/state).
#
# The [ai] binding is stripped from the generated config: wrangler can only
# serve it in remote mode, which needs a Cloudflare login. The e2e doesn't
# exercise Workers AI (markdown landing), so the local run doesn't need it.
#
# Usage: npm run test:e2e:local   (PORT=8788 to change the port)
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
WORK=".wrangler/e2e"
WRANGLER="node node_modules/wrangler/bin/wrangler.js"

rm -rf "$WORK"
mkdir -p "$WORK"

# Config lives in $WORK, so repoint the paths that are relative to it and
# drop the remote-only bits (AI binding, custom-domain route, account id).
sed \
  -e '/^\[ai\]/,/^binding = "AI"/d' \
  -e '/^routes = \[/,/^\]/d' \
  -e '/^account_id/d' \
  -e 's#^main = .*#main = "../../src/index.ts"#' \
  -e 's#^migrations_dir = .*#migrations_dir = "../../migrations"#' \
  wrangler.toml > "$WORK/wrangler.toml"

cat > "$WORK/.dev.vars" <<EOF
PUBLIC_URL="http://localhost:${PORT}"
TOKEN_PEPPER="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
GITHUB_CLIENT_ID="dev-mock"
GITHUB_CLIENT_SECRET="dev-mock"
EOF

export WRANGLER_SEND_METRICS=false

$WRANGLER d1 execute htmlbin-db --local \
  --config "$WORK/wrangler.toml" --persist-to "$WORK/state" \
  --file=./schema.sql >/dev/null

$WRANGLER dev --config "$WORK/wrangler.toml" --persist-to "$WORK/state" \
  --port "$PORT" >"$WORK/dev.log" 2>&1 &
DEV_PID=$!
trap 'kill "$DEV_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://localhost:${PORT}/"; then break; fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "wrangler dev exited early:" >&2
    cat "$WORK/dev.log" >&2
    exit 1
  fi
  sleep 1
done

# Smoke first: agent-e2e burns through the /api/auth/start rate limit.
BASE_URL="http://localhost:${PORT}" ./scripts/smoke.sh
BASE_URL="http://localhost:${PORT}" ./scripts/agent-e2e.sh
