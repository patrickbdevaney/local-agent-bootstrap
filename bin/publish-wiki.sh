#!/usr/bin/env bash
# Publish wiki/*.md to the repository's GitHub wiki.
#
# GitHub wikis live in a separate `<repo>.wiki.git` repository that does not exist
# until the wiki feature is enabled AND a first page has been created in the web UI.
# Until then this script will fail with "Repository not found" — that is expected,
# not a bug. One-time setup:
#
#   1. repo Settings -> Features -> tick "Wikis"
#   2. open the Wiki tab and create any page (title/content don't matter)
#   3. run this script; it overwrites that page with wiki/Home.md
#
# The wiki/ directory in this repo is the source of truth either way and renders
# fine on its own, so this is a convenience, not a requirement.

set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
REMOTE="$(git -C "$ROOT" remote get-url origin)"
WIKI_REMOTE="${REMOTE%.git}.wiki.git"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "wiki remote: $WIKI_REMOTE"

if ! git clone -q "$WIKI_REMOTE" "$TMP/wiki" 2>/dev/null; then
  cat >&2 <<EOF
error: could not clone $WIKI_REMOTE

The wiki has not been initialized yet. Enable it in the repository settings and
create one page in the web UI, then re-run this script. See the header of this
file for the exact steps.
EOF
  exit 1
fi

cp "$ROOT"/wiki/*.md "$TMP/wiki/"

cd "$TMP/wiki"
git add -A
if git diff --cached --quiet; then
  echo "wiki already up to date"
  exit 0
fi

git commit -qm "Sync wiki from repo wiki/ ($(git -C "$ROOT" rev-parse --short HEAD))"
git push -q origin HEAD
echo "published $(ls "$ROOT"/wiki/*.md | wc -l) pages"
