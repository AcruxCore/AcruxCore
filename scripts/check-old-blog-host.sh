#!/usr/bin/env bash
# Fails when a tracked file links to the blog's old host, docs.acruxcore.com/blog.
#
# The blog moved to https://acruxcore.com/blog (cross-cutting FAQ Q129). Old
# links still work through a 301, but an internal link that relies on the
# redirect costs a hop and keeps the old host alive in our own pages, so every
# file we control must link the new host directly. Files that must keep the old
# URL are listed, one by one, in scripts/old-blog-host-allowlist.txt.
#
# Usage: scripts/check-old-blog-host.sh   (from anywhere inside the repo)
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

excludes=()
while IFS= read -r line; do
  line="${line%%#*}"
  line="$(printf '%s' "$line" | tr -d '[:space:]')"
  [ -n "$line" ] && excludes+=(":(exclude)$line")
done <scripts/old-blog-host-allowlist.txt

# The second pattern catches the marketing site, which builds docs URLs from a
# DOCS_URL constant rather than spelling the host out.
if hits="$(git grep -n -I -E 'docs\.acruxcore\.com/blog|DOCS_URL\}/blog' -- . "${excludes[@]}")"; then
  echo "These files link to docs.acruxcore.com/blog. Use https://acruxcore.com/blog instead:" >&2
  echo "$hits" >&2
  exit 1
fi
echo "No links to docs.acruxcore.com/blog."
