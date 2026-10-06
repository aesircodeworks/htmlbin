#!/usr/bin/env bash
# Post-deploy smoke test. A handful of cheap requests that prove a freshly
# deployed Worker is actually serving — not answering 503
# `server_misconfigured` because a secret is missing on that deployment.
#
# Read-only apart from POST /api/auth/start, which inserts one pending
# verification row that expires on its own (VERIFY_TTL_MS) and is swept by
# sweepExpiredAuthState(). Never mints a token, never touches drops.
#
# Each check retries a few times, so a deploy that is still propagating
# doesn't fail the run. A 503 is reported with its error.code so the CI log
# says which secret is missing.
#
# Usage: BASE_URL=https://htmlbin.aesir.works ./scripts/smoke.sh
set -u
BASE="${BASE_URL:?BASE_URL is required}"
BASE="${BASE%/}"
ATTEMPTS="${SMOKE_ATTEMPTS:-5}"
# Production sits behind a bot rule that 403s (error 1010) requests
# without a User-Agent.
UA="htmlbin-smoke/1"
PASS=0
FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

R="\033[31m"; G="\033[32m"; D="\033[2m"; X="\033[0m"

# request <method> <path> — fills $TMP/body, $TMP/headers; echoes status.
request() {
  : > "$TMP/body"; : > "$TMP/headers"
  # curl already prints 000 when it can't connect; `|| true` keeps it to one.
  curl -s -A "$UA" -X "$1" -o "$TMP/body" -D "$TMP/headers" \
    -w "%{http_code}" --max-time 20 "$BASE$2" 2>/dev/null || true
}

# check <name> <method> <path> <want_status> <predicate fn>
check() {
  local name="$1" method="$2" path="$3" want="$4" pred="$5"
  local status="" why="" i
  for i in $(seq 1 "$ATTEMPTS"); do
    status=$(request "$method" "$path")
    if [ "$status" = "$want" ]; then
      if why=$("$pred"); then
        PASS=$((PASS+1)); printf "  ${G}✓${X} %s\n" "$name"; return
      fi
    else
      why="got HTTP $status, want $want"
      if [ "$status" = "503" ]; then
        why="$why ($(jq -r '.error.code + ": " + .error.message' < "$TMP/body" 2>/dev/null || head -c 200 "$TMP/body"))"
      fi
    fi
    if [ "$i" -lt "$ATTEMPTS" ]; then
      printf "    ${D}%s: attempt %d failed (%s), retrying${X}\n" "$name" "$i" "$why"
      sleep $((i * 3))
    fi
  done
  FAIL=$((FAIL+1)); printf "  ${R}✗${X} %s${R} — %s${X}\n" "$name" "$why"
}

header_has() { tr -d '\r' < "$TMP/headers" | grep -qi "^$1:.*$2"; }

is_landing() {
  header_has content-type text/html || { echo "content-type is not text/html"; return 1; }
  grep -q "htmlbin" "$TMP/body" || { echo "body does not mention htmlbin"; return 1; }
}
is_onboard() {
  header_has content-type application/json || { echo "content-type is not JSON"; return 1; }
  jq -e '.auth.steps | length > 0' < "$TMP/body" >/dev/null || { echo "missing auth.steps"; return 1; }
}
is_llms() {
  grep -q "/api/onboard" "$TMP/body" || { echo "does not reference /api/onboard"; return 1; }
}
is_api_404() {
  local code
  code=$(jq -r '.error.code' < "$TMP/body" 2>/dev/null)
  [ "$code" = "not_found" ] || { echo "error.code=$code, want not_found"; return 1; }
}
is_html_404() {
  header_has content-type text/html || { echo "content-type is not text/html"; return 1; }
}
is_auth_start() {
  jq -e '(.code|type=="string") and (.poll_token|type=="string") and (.verification_url|startswith("http"))' \
    < "$TMP/body" >/dev/null || { echo "missing code / poll_token / verification_url"; return 1; }
}

printf "smoke test against %s\n" "$BASE"
check "GET / serves the landing page"          GET  "/"                200 is_landing
check "GET /api/onboard returns the descriptor" GET  "/api/onboard"     200 is_onboard
check "GET /llms.txt lists the API"            GET  "/llms.txt"        200 is_llms
check "GET /api/nope is a JSON 404"            GET  "/api/nope"        404 is_api_404
check "GET /p/<unknown> is an HTML 404"        GET  "/p/zzzzzzzzz"     404 is_html_404
check "POST /api/auth/start starts device auth" POST "/api/auth/start"  200 is_auth_start

printf "\n%d passed, %d failed\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
