#!/usr/bin/env bash
# Prints the release notes for a tag: every commit since the previous v* tag (the whole history for the first
# release), newest first, with a compare link. Used by .github/workflows/release.yml.
#
#   GITHUB_SERVER_URL=https://github.com GITHUB_REPOSITORY=owner/repo scripts/ci/release-notes.sh v1.2.0
set -euo pipefail
tag="$1"
repo_url="${GITHUB_SERVER_URL:?}/${GITHUB_REPOSITORY:?}"
# A shallow clone hides the previous tag and would silently produce a one-commit log
[ "$(git rev-parse --is-shallow-repository)" = false ] || { echo "release-notes: shallow clone, fetch full history" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "release-notes: no tag $tag" >&2; exit 1; }

if prev="$(git describe --tags --abbrev=0 --match 'v*' "$tag^" 2>/dev/null)"; then
  range="$prev..$tag"
  echo "## Changes since $prev"
else
  range="$tag"
  echo "## Changes"
fi
echo
log="$(git log --no-merges --format='- %s (%h)' "$range")"
[ -n "$log" ] || { echo "release-notes: no commits in $range" >&2; exit 1; }
echo "$log"
if [ -n "$prev" ]; then
  echo
  echo "**Full changelog**: $repo_url/compare/$prev...$tag"
fi
