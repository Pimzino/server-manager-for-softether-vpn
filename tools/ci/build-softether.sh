#!/usr/bin/env bash
# Build SoftEther VPN (server, client, vpncmd) from the official source at a pinned release commit,
# for the E2E suites on Linux and macOS runners. Output: $1 (default ./se-build) containing
# vpnserver, vpnclient, vpncmd, hamcore.se2 and the shared libraries.
set -euo pipefail

OUT="${1:-$PWD/se-build}"
# Release 5.2.5188 of github.com/SoftEtherVPN/SoftEtherVPN
SE_TAG="5.2.5188"
SE_COMMIT="10d6efcc5e3329e5a959a99c6e939648f41121bf"

if [ -x "$OUT/vpnserver" ] && [ -f "$OUT/hamcore.se2" ]; then
  echo "SoftEther already built in $OUT"
  exit 0
fi

SRC="$(mktemp -d)/SoftEtherVPN"
git clone --depth 1 --branch "$SE_TAG" --recurse-submodules --shallow-submodules https://github.com/SoftEtherVPN/SoftEtherVPN.git "$SRC"
ACTUAL="$(git -C "$SRC" rev-parse HEAD)"
if [ "$ACTUAL" != "$SE_COMMIT" ]; then
  echo "Tag $SE_TAG resolved to $ACTUAL, expected $SE_COMMIT: refusing to build" >&2
  exit 1
fi

if [ "$(uname)" = "Darwin" ]; then
  PREFIX="$(brew --prefix)"
  export PKG_CONFIG_PATH="$PREFIX/opt/openssl@3/lib/pkgconfig:$PREFIX/opt/readline/lib/pkgconfig:$PREFIX/opt/ncurses/lib/pkgconfig:$PREFIX/opt/zlib/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
  JOBS="$(sysctl -n hw.ncpu)"
else
  JOBS="$(nproc)"
fi

cd "$SRC"
./configure
make -C build -j"$JOBS"

mkdir -p "$OUT"
for f in vpnserver vpnclient vpncmd hamcore.se2 libcedar.so libmayaqua.so libcedar.dylib libmayaqua.dylib; do
  [ -e "build/$f" ] && cp -f "build/$f" "$OUT/"
done
ls -l "$OUT"
