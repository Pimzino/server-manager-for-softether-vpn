#!/usr/bin/env bash
# Runs a local SoftEther VPN Server for development (JSON-RPC on https://127.0.0.1:5555, empty admin password).
# Uses binaries built from vendor/SoftEtherVPN (SE_BUILD_DIR, default ~/se-build/src/build).
set -euo pipefail
BUILD="${SE_BUILD_DIR:-$HOME/se-build/src/build}"
RUN="${SE_DEV_DIR:-$HOME/se-dev/vpnserver}"
mkdir -p "$RUN"
for f in vpnserver hamcore.se2 libcedar.dylib libmayaqua.dylib libcedar.so libmayaqua.so; do
  [ -f "$BUILD/$f" ] && cp -f "$BUILD/$f" "$RUN/"
done
cd "$RUN"
export DYLD_LIBRARY_PATH=. LD_LIBRARY_PATH=.
# exec so stopping the launcher stops the server (execsvc runs in the foreground)
exec ./vpnserver execsvc
