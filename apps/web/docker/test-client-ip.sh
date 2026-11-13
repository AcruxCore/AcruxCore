#!/usr/bin/env bash
# End-to-end test of the client address apps/web/nginx.conf hands the API.
#
# The API's sign-in rate limiter keys on that address, so it must be one the
# caller cannot choose. CF-Connecting-IP is only trustworthy when Cloudflare set
# it, and only the hop that received the connection from Cloudflare can tell.
# This runs the real nginx image in four network positions and checks what
# reaches a stub API:
#
#   * a client straight to nginx, spoofing CF-Connecting-IP and X-Forwarded-For
#   * a Cloudflare edge straight to nginx
#   * a client through a host reverse proxy (production's shape: Cloudflare, a
#     proxy container on the shared Docker network, then this nginx)
#   * a Cloudflare edge through that host reverse proxy
#
# Docker networks with chosen subnets stand in for the internet (TEST-NET-2,
# 198.51.100.0/24) and for a Cloudflare edge (173.245.48.0/28, inside one of
# Cloudflare's published ranges).
#
# Usage: apps/web/docker/test-client-ip.sh   (needs Docker; about 20 s; exits
# non-zero on a failed check)
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
nginx_image="nginx:1.27-alpine"
py_image="python:3.12-alpine"
id="$$"
back="acx-ip-back-$id"
pub="acx-ip-pub-$id"
cf="acx-ip-cf-$id"
work="$(mktemp -d)"
failures=0

client_ip="198.51.100.10"
edge_ip="173.245.48.10"
# The visitor Cloudflare reports in CF-Connecting-IP.
visitor="203.0.113.7"

cleanup() {
  docker rm -f "acx-ip-api-$id" "acx-ip-web-$id" "acx-ip-behind-$id" "acx-ip-proxy-$id" \
    >/dev/null 2>&1 || true
  docker network rm "$back" "$pub" "$cf" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work/html"
echo '<html>landing page</html>' >"$work/html/index.html"
echo '<html>app shell</html>' >"$work/html/app-shell.html"
echo '<html>not found page</html>' >"$work/html/404.html"

# The stub API answers with the address headers it received.
cat >"$work/stub.py" <<'PY'
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({
            "xff": self.headers.get("X-Forwarded-For"),
            "real": self.headers.get("X-Real-IP"),
            "cf": self.headers.get("CF-Connecting-IP"),
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

ThreadingHTTPServer(("0.0.0.0", 3001), Handler).serve_forever()
PY

# A host reverse proxy as most are configured: it appends its own peer to
# X-Forwarded-For and forwards every other header unchanged.
cat >"$work/proxy.conf" <<'NGINX'
server {
    listen 80;
    location / {
        proxy_pass http://behind:80;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
NGINX

# Prints the JSON the stub saw for one request sent from a container at $2 on
# network $1 to URL $3, with any further arguments as "Name: value" headers.
probe() {
  local net="$1" ip="$2" url="$3"
  shift 3
  local headers="{"
  for h in "$@"; do headers+="\"${h%%: *}\": \"${h#*: }\","; done
  headers="${headers%,}}"
  docker run --rm --network "$net" --ip "$ip" "$py_image" python -c "
import urllib.request
req = urllib.request.Request('$url', headers=$headers)
print(urllib.request.urlopen(req, timeout=10).read().decode())"
}

docker network create "$back" >/dev/null
docker network create --subnet 198.51.100.0/24 "$pub" >/dev/null
docker network create --subnet 173.245.48.0/28 "$cf" >/dev/null

docker run -d --name "acx-ip-api-$id" --network "$back" --network-alias api \
  -v "$work/stub.py:/stub.py:ro" "$py_image" python -u /stub.py >/dev/null

web_mounts=(
  -v "$repo/apps/web/nginx.conf:/etc/nginx/conf.d/default.conf:ro"
  -v "$repo/apps/web/docker/security-headers.conf:/etc/nginx/snippets/security-headers.conf:ro"
  -v "$work/html:/usr/share/nginx/html:ro"
)
# Reached directly from the internet and from Cloudflare.
docker run -d --name "acx-ip-web-$id" --network "$back" --network-alias web \
  "${web_mounts[@]}" "$nginx_image" >/dev/null
docker network connect --alias web "$pub" "acx-ip-web-$id"
docker network connect --alias web "$cf" "acx-ip-web-$id"
# Reached only through the host reverse proxy, over the private network.
docker run -d --name "acx-ip-behind-$id" --network "$back" --network-alias behind \
  "${web_mounts[@]}" "$nginx_image" >/dev/null
docker run -d --name "acx-ip-proxy-$id" --network "$back" --network-alias hostproxy \
  -v "$work/proxy.conf:/etc/nginx/conf.d/default.conf:ro" "$nginx_image" >/dev/null
docker network connect --alias hostproxy "$pub" "acx-ip-proxy-$id"
docker network connect --alias hostproxy "$cf" "acx-ip-proxy-$id"
sleep 3

check() { # description, then a command that must succeed
  local what="$1"
  shift
  if "$@"; then echo "ok   - $what"; else echo "FAIL - $what"; failures=$((failures + 1)); fi
}
# The stub's JSON for one field, "None" when the header was absent or empty.
field() { python3 -c "import json,sys; v=json.loads(sys.argv[1])[sys.argv[2]]; print(v or None)" "$1" "$2"; }

spoof=("CF-Connecting-IP: 192.0.2.1" "X-Forwarded-For: 192.0.2.2")

echo "# client -> nginx, spoofing both headers"
out="$(probe "$pub" "$client_ip" "http://web/api/echo" "${spoof[@]}")"
echo "  stub saw: $out"
check "X-Forwarded-For is the real peer" test "$(field "$out" xff)" = "$client_ip"
check "X-Real-IP is the real peer" test "$(field "$out" real)" = "$client_ip"
check "the client's CF-Connecting-IP is not forwarded" test "$(field "$out" cf)" = None

echo "# Cloudflare edge -> nginx"
out="$(probe "$cf" "$edge_ip" "http://web/api/echo" \
  "CF-Connecting-IP: $visitor" "X-Forwarded-For: $visitor")"
echo "  stub saw: $out"
check "X-Forwarded-For is the visitor Cloudflare reported" test "$(field "$out" xff)" = "$visitor"

echo "# client -> host proxy -> nginx, spoofing both headers"
out="$(probe "$pub" "$client_ip" "http://hostproxy/api/echo" "${spoof[@]}")"
echo "  stub saw: $out"
check "X-Forwarded-For is the address the host proxy saw" test "$(field "$out" xff)" = "$client_ip"
check "the client's CF-Connecting-IP is not forwarded" test "$(field "$out" cf)" = None

echo "# Cloudflare edge -> host proxy -> nginx"
out="$(probe "$cf" "$edge_ip" "http://hostproxy/api/echo" \
  "CF-Connecting-IP: $visitor" "X-Forwarded-For: 192.0.2.9, $visitor")"
echo "  stub saw: $out"
check "X-Forwarded-For is the visitor Cloudflare reported" test "$(field "$out" xff)" = "$visitor"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
