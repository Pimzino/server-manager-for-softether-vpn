#!/usr/bin/env bash
# Reproducibly build the setup launcher stubs with mingw-w64 (brew install mingw-w64 / apt install mingw-w64).
# Output is committed to apps/server/assets/ so the management server needs no compiler at run time.
set -euo pipefail
cd "$(dirname "$0")"
OUT=../../apps/server/assets
mkdir -p "$OUT"
for arch in x86_64 i686; do
  name=$([ "$arch" = x86_64 ] && echo x64 || echo x86)
  "$arch-w64-mingw32-windres" stub.rc -O coff -o "stub-$name.res"
  "$arch-w64-mingw32-gcc" -Os -s -municode -mwindows -static -fno-ident -Wl,--no-insert-timestamp \
    -Wall -Wextra -o "$OUT/setup-stub-$name.exe" stub.c "stub-$name.res" -lshell32
  rm -f "stub-$name.res"
done
cp default.ico "$OUT/default.ico"
ls -l "$OUT"
