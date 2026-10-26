#!/bin/sh
# Wrapper that scripts/dist.mjs hands to electron-builder as ELECTRON_BUILDER_OSSL_SIGNCODE_PATH.
# osslsigncode 2.11 (electron-builder's win-codesign 1.1.0 bundle) fails to open a password-protected .pfx with
# "Failed to read certificate from: (null) / passphrase callback error" when its stdin is a pipe, which is how
# electron-builder 26.15.3 runs it (execFile). With stdin redirected from /dev/null the same command succeeds.
exec "${SEM_REAL_OSSLSIGNCODE:?SEM_REAL_OSSLSIGNCODE not set}" "$@" </dev/null
