#!/usr/bin/env bash
# End-to-end test of the /blog/ proxy in apps/web/nginx.conf + 41-blog-proxy.sh.
#
# Runs the web image's nginx base with the repo's nginx.conf and entrypoint
# script mounted, against a stub upstream that serves the nested blog deploy
# folder (apps/docs/deploy-blog, built as in .github/workflows/docs.yml). Then it
# runs the same nginx with BLOG_UPSTREAM unset, which is what every self-hosted
# install gets, and checks that nothing changed for them.
#
# Usage: apps/web/docker/test-blog-proxy.sh   (needs Docker and a built
# apps/docs/deploy-blog; exits non-zero on the first failed check)
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
deploy="$repo/apps/docs/deploy-blog"
nginx_image="nginx:1.27-alpine"
net="acx-blogtest-$$"
work="$(mktemp -d)"
port_on=18081
port_off=18082
port_bad=18083
failures=0

cleanup() {
  docker rm -f "acx-blogstub-$$" "acx-web-on-$$" "acx-web-off-$$" "acx-web-bad-$$" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

[ -f "$deploy/blog/index.html" ] || {
  echo "missing $deploy/blog/index.html — build the blog and nest it first" >&2
  exit 2
}
post="$(cd "$deploy/blog" && ls ./*.html | grep -v -e index -e 404 -e archive -e authors | head -1)"
post="${post#./}"
blog_js="$(cd "$deploy/blog/assets/js" && ls | head -1)"

# A stand-in for the Vite build: the landing page, the app shell, the 404 page,
# one prerendered page, one asset.
mkdir -p "$work/html/about" "$work/html/assets"
echo '<html>landing page</html>' >"$work/html/index.html"
echo '<html>app shell</html>' >"$work/html/app-shell.html"
echo '<html>not found page</html>' >"$work/html/404.html"
echo '<html>about page</html>' >"$work/html/about/index.html"
echo 'console.log(1)' >"$work/html/assets/app-abc123.js"

docker network create "$net" >/dev/null
docker run -d --name "acx-blogstub-$$" --network "$net" --network-alias blogstub \
  -v "$deploy:/srv:ro" python:3.12-alpine python -m http.server 8000 -d /srv >/dev/null

start_web() { # name port [env...]
  local name="$1" port="$2"
  shift 2
  docker run -d --name "$name" --network "$net" --add-host api:127.0.0.1 -p "$port:80" \
    -v "$repo/apps/web/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
    -v "$repo/apps/web/docker/security-headers.conf:/etc/nginx/snippets/security-headers.conf:ro" \
    -v "$repo/apps/web/docker/41-blog-proxy.sh:/docker-entrypoint.d/41-blog-proxy.sh:ro" \
    -v "$work/html:/usr/share/nginx/html:ro" \
    "$@" "$nginx_image" >/dev/null
}
start_web "acx-web-on-$$" "$port_on" -e BLOG_UPSTREAM=http://blogstub:8000
start_web "acx-web-off-$$" "$port_off"
# A value that is not a bare origin must never reach nginx config.
start_web "acx-web-bad-$$" "$port_bad" -e 'BLOG_UPSTREAM=https://x.dev/a;return 200 pwned'
sleep 3

check() { # description, then a command that must succeed
  local what="$1"
  shift
  if "$@"; then echo "ok   - $what"; else echo "FAIL - $what"; failures=$((failures + 1)); fi
}
status() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
header() { curl -s -D - -o /dev/null "$1" | tr -d '\r' | grep -i "^$2:" | cut -d' ' -f2-; }
body() { curl -s "$1"; }
on="http://localhost:$port_on"
off="http://localhost:$port_off"

echo "# with BLOG_UPSTREAM set"
check "a post is proxied (200)" test "$(status "$on/blog/$post")" = 200
check "the post carries the acruxcore.com canonical" \
  grep -q "canonical href=https://acruxcore.com/blog/" <(body "$on/blog/$post")
check "/blog 301s to /blog/" test "$(status "$on/blog")" = 301
check "/blog Location is /blog/" test "$(header "$on/blog" location)" = /blog/
check "/blog/ serves the blog index (200)" test "$(status "$on/blog/")" = 200
check "/blog/ is the blog, not the landing page" grep -q "AcruxCore blog" <(body "$on/blog/")
check "a missing post is a real 404" test "$(status "$on/blog/no-such-post")" = 404
check "a missing post is not served noindex" test -z "$(header "$on/blog/no-such-post" x-robots-tag)"
check "blog assets are proxied (200)" test "$(status "$on/blog/assets/js/$blog_js")" = 200
check "blog assets are JavaScript, not the shell" \
  grep -q javascript <(header "$on/blog/assets/js/$blog_js" content-type)
check "Vite /assets/ still served (200)" test "$(status "$on/assets/app-abc123.js")" = 200
check "Vite /assets/ keep the long cache" \
  grep -q immutable <(header "$on/assets/app-abc123.js" cache-control)
check "a prerendered marketing page is unchanged" grep -q "about page" <(body "$on/about")

echo "# with BLOG_UPSTREAM unset (self-hosted)"
check "nginx is running" test "$(docker inspect -f '{{.State.Running}}' "acx-web-off-$$")" = true
check "/blog/<post> is a real 404" test "$(status "$off/blog/$post")" = 404
check "that 404 serves the not-found page" grep -q "not found page" <(body "$off/blog/$post")
check "that 404 is noindex" grep -q noindex <(header "$off/blog/$post" x-robots-tag)
check "a dashboard route serves the app shell (200)" test "$(status "$off/prompts/abc123")" = 200
check "the app shell is the app, not the landing page" grep -q "app shell" <(body "$off/prompts/abc123")
check "an unknown path is a real 404" test "$(status "$off/zzz-nonexistent-123")" = 404
check "the app shell has no address of its own" test "$(status "$off/app-shell.html")" = 404

echo "# with an invalid BLOG_UPSTREAM"
check "nginx is running" test "$(docker inspect -f '{{.State.Running}}' "acx-web-bad-$$")" = true
check "the proxy stays off (a 404)" test "$(status "http://localhost:$port_bad/blog/$post")" = 404
check "the warning is logged" grep -q "is not a bare http(s) origin" <(docker logs "acx-web-bad-$$" 2>&1)

echo "# $failures failed"
[ "$failures" -eq 0 ]
