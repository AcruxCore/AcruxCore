#!/usr/bin/env bash
# End-to-end test of the response headers apps/web/nginx.conf sends.
#
# Runs the web image's nginx base with the repo's nginx.conf and the security
# header snippet mounted, against a stub site (the landing page, the app shell,
# the 404 page, one prerendered page, one hashed asset, llms.txt and the API
# catalog), and checks every
# location that sets headers of its own. nginx drops server-level add_header
# lines in any location that has its own, so each of those is checked by name.
#
# Usage: apps/web/docker/test-headers.sh   (needs Docker; exits non-zero on the
# first run with a failed check)
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
nginx_image="nginx:1.27-alpine"
work="$(mktemp -d)"
port=18084
name="acx-web-headers-$$"
failures=0

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work/html/about" "$work/html/assets" "$work/html/media" "$work/html/.well-known"
echo '<html>landing page</html>' >"$work/html/index.html"
echo '<html>app shell</html>' >"$work/html/app-shell.html"
echo '<html>not found page</html>' >"$work/html/404.html"
echo '<html>about page</html>' >"$work/html/about/index.html"
echo 'console.log(1)' >"$work/html/assets/app-abc123.js"
echo '# AcruxCore' >"$work/html/llms.txt"
echo 'window.__ACRUXCORE_CONFIG__ = {};' >"$work/html/runtime-config.js"
echo '{"linkset":[]}' >"$work/html/.well-known/api-catalog"
printf 'jpg' >"$work/html/media/intro-poster.jpg"

docker run -d --name "$name" --add-host api:127.0.0.1 -p "$port:80" \
  -v "$repo/apps/web/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$repo/apps/web/docker/security-headers.conf:/etc/nginx/snippets/security-headers.conf:ro" \
  -v "$work/html:/usr/share/nginx/html:ro" \
  "$nginx_image" >/dev/null
sleep 2

check() { # description, then a command that must succeed
  local what="$1"
  shift
  if "$@"; then echo "ok   - $what"; else echo "FAIL - $what"; failures=$((failures + 1)); fi
}
# header URL NAME [HOST] — the value of one response header, empty when absent.
header() {
  curl -s -D - -o /dev/null -H "Host: ${3:-acruxcore.com}" "$1" | tr -d '\r' |
    grep -i "^$2:" | cut -d' ' -f2- || true
}
count() { # URL NAME — how many times a header appears
  curl -s -D - -o /dev/null -H "Host: acruxcore.com" "$1" | tr -d '\r' | grep -ci "^$2:" || true
}
base="http://localhost:$port"

check "nginx is running" test "$(docker inspect -f '{{.State.Running}}' "$name")" = true

# Every location that has its own add_header, plus the plain and redirect cases.
for path in / /about /no-such-page /prompts/abc123 /assets/app-abc123.js /llms.txt /runtime-config.js \
  /.well-known/api-catalog /about/ /features; do
  echo "# $path"
  check "$path sends HSTS on acruxcore.com" \
    test "$(header "$base$path" strict-transport-security)" = "max-age=31536000; includeSubDomains"
  check "$path sends nosniff" test "$(header "$base$path" x-content-type-options)" = nosniff
  check "$path sends X-Frame-Options DENY" test "$(header "$base$path" x-frame-options)" = DENY
  check "$path sends Referrer-Policy" \
    test "$(header "$base$path" referrer-policy)" = strict-origin-when-cross-origin
  check "$path sends a Permissions-Policy" test -n "$(header "$base$path" permissions-policy)"
  check "$path sends each security header once" test "$(count "$base$path" x-frame-options)" = 1
done

echo "# location-specific headers survive"
check "/ keeps its Link header" grep -q 'rel="api-catalog"' <(header "$base/" link)
check "the 404 page stays noindex" grep -q noindex <(header "$base/no-such-page" x-robots-tag)
check "the app shell stays noindex" grep -q noindex <(header "$base/prompts/abc123" x-robots-tag)
check "/assets/ keep the long immutable cache" \
  grep -q immutable <(header "$base/assets/app-abc123.js" cache-control)
check "/runtime-config.js stays no-store" test "$(header "$base/runtime-config.js" cache-control)" = no-store
check "the API catalog keeps its CORS header" \
  test "$(header "$base/.well-known/api-catalog" access-control-allow-origin)" = '*'

echo "# llms.txt"
check "/llms.txt is served as Markdown" \
  test "$(header "$base/llms.txt" content-type)" = "text/markdown; charset=utf-8"

echo "# other hosts (self-hosted installs)"
check "no HSTS for a host that is not acruxcore.com" \
  test -z "$(header "$base/" strict-transport-security localhost)"
check "the other security headers still apply there" \
  test "$(header "$base/" x-frame-options localhost)" = DENY

echo "# $failures failed"
[ "$failures" -eq 0 ]
