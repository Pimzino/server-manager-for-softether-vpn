#!/usr/bin/env bash
# Mirror the project to the internal disk so the Claude app's browser-pane servers can run it
# (macOS blocks those processes from reading removable volumes). Re-run after editing files.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${SEM_DEV_MIRROR:-$HOME/softether-dev}"
mkdir -p "$DST"
rsync -a --delete \
  --exclude '._*' --exclude '.DS_Store' --exclude '/.git' --exclude '/vendor' \
  --exclude '/e2e/artifacts' --exclude '/data' \
  "$SRC/" "$DST/"
echo "synced $SRC -> $DST"
