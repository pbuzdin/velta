#!/bin/bash
# Zipalign + sign the APK from tools/wsl-android-build.sh.
#   tools/wsl-android-sign.sh [universal|aarch64]
# (tools/wsl-android-sign-aarch64.sh is a wrapper for aarch64.)
set -e

TARGET=universal
case "${1:-}" in
  universal|aarch64) TARGET="$1"; shift ;;
esac
if [ "$TARGET" = aarch64 ]; then ABI=arm64; BUILD_SCRIPT=wsl-android-build-aarch64.sh
else ABI=universal; BUILD_SCRIPT=wsl-android-build.sh; fi

source "$HOME/.cargo/env" 2>/dev/null || true
export JAVA_HOME=/home/pave/jdk/jdk-17
export ANDROID_HOME=/home/pave/android
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/build-tools/35.0.0:$PATH"

cd ~/velta/velta-app

UNSIGNED=src-tauri/gen/android/app/build/outputs/apk/$ABI/release/app-$ABI-release-unsigned.apk
ALIGNED=src-tauri/gen/android/app/build/outputs/apk/$ABI/release/app-$ABI-release-zipaligned.apk
SIGNED=src-tauri/gen/android/app/build/outputs/apk/$ABI/release/app-$ABI-release-signed.apk
KS=/home/pave/android/keystore/velta-debug.keystore

if [ ! -f "$UNSIGNED" ]; then
    echo "Unsigned APK not found: $UNSIGNED"
    echo "Run tools/$BUILD_SCRIPT first."
    exit 1
fi

rm -f "$ALIGNED" "$SIGNED"

zipalign -p -f 4 "$UNSIGNED" "$ALIGNED"
apksigner sign --ks "$KS" --ks-pass pass:velta123 --key-pass pass:velta123 \
  --out "$SIGNED" "$ALIGNED"

echo "Signed APK: $SIGNED"
ls -lh "$SIGNED"
