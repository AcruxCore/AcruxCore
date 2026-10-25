#!/usr/bin/env bash
# End-to-end test that apps/web/nginx.conf waits long enough for the API.
#
# A gateway call can legitimately take more than 60 seconds before the API
# answers: the provider gets up to 60 seconds for its response headers, and a
# fallback chain can try a second model after that. nginx's default
# proxy_read_timeout is also 60 seconds. When nginx gives up first it answers
# with its own HTML 504, and Cloudflare replaces that with its HTML page, so the
# caller never sees the API's JSON error or its traceId (issue #732).
#
# Runs the web image's nginx base with the repo's nginx.conf mounted, in front of
# a stub API that answers a JSON 503 after STUB_DELAY seconds, and checks that the
# JSON reaches the client.
#
# Usage: apps/web/docker/test-api-timeout.sh   (needs Docker; takes about
# STUB_DELAY seconds; exits non-zero on a failed check)
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
nginx_image="nginx:1.27-alpine"
net="acx-apitimeout-$$"
work="$(mktemp -d)"
port=18085
# Longer than nginx's 60 s default, shorter than the API's own 90 s ceiling
# (GATEWAY_CHAIN_DEADLINE_MS) plus headroom.
delay="${STUB_DELAY:-75}"
failures=0

cleanup() {
  docker rm -f "acx-apistub-$$" "acx-web-timeout-$$" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work/html"
echo '<html>landing page</html>' >"$work/html/index.html"
echo '<html>app shell</html>' >"$work/html/app-shell.html"
echo '<html>not found page</html>' >"$work/html/404.html"

# The stub API: sleeps, then answers the same shape the gateway sends for a
# provider timeout.
cat >"$work/stub.py" <<PY
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BODY = b'{"error":{"code":"PROVIDER_TIMEOUT","message":"Provider timed out.","traceId":"stub-trace"}}'

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        time.sleep($delay)
        self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

ThreadingHTTPServer(("0.0.0.0", 3001), Handler).serve_forever()
PY

docker network create "$net" >/dev/null
docker run -d --name "acx-apistub-$$" --network "$net" --network-alias api \
  -v "$work/stub.py:/stub.py:ro" python:3.12-alpine python -u /stub.py >/dev/null
docker run -d --name "acx-web-timeout-$$" --network "$net" -p "$port:80" \
  -v "$repo/apps/web/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$repo/apps/web/docker/security-headers.conf:/etc/nginx/snippets/security-headers.conf:ro" \
  -v "$work/html:/usr/share/nginx/html:ro" \
  "$nginx_image" >/dev/null
sleep 3

check() { # description, then a command that must succeed
  local what="$1"
  shift
  if "$@"; then echo "ok   - $what"; else echo "FAIL - $what"; failures=$((failures + 1)); fi
}

echo "# POST through nginx; the stub answers after ${delay}s"
out="$(curl -s -D - -X POST "http://localhost:$port/api/v1/gateway/chat/completions" \
  -H 'Content-Type: application/json' -d '{"model":"m","messages":[]}' | tr -d '\r')"
status="$(printf '%s\n' "$out" | head -1 | cut -d' ' -f2)"
ctype="$(printf '%s\n' "$out" | grep -i '^content-type:' | cut -d' ' -f2- || true)"
echo "  got: HTTP $status, content-type: $ctype"
check "the API's status reaches the client (503, not nginx's 504)" test "$status" = 503
check "the body is the API's JSON" test "$ctype" = application/json
check "the traceId survives" grep -q '"traceId":"stub-trace"' <<<"$out"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
