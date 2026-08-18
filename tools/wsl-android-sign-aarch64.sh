#!/bin/bash
set -e

source "$HOME/.cargo/env" 2>/dev/null || true
export JAVA_HOME=/home/pave/jdk/jdk-17
export ANDROID_HOME=/home/pave/android
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/build-tools/35.0.0:$PATH"

cd ~/velta/delta-web-app

UNSIGNED=src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release-unsigned.apk
ALIGNED=src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release-zipaligned.apk
SIGNED=src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release-signed.apk
KS=/home/pave/android/keystore/velta-debug.keystore

if [ ! -f "$UNSIGNED" ]; then
    echo "Unsigned APK not found: $UNSIGNED"
    echo "Run tools/wsl-android-build-aarch64.sh first."
    exit 1
fi

rm -f "$ALIGNED" "$SIGNED"

zipalign -p -f 4 "$UNSIGNED" "$ALIGNED"
apksigner sign --ks "$KS" --ks-pass pass:velta123 --key-pass pass:velta123 \
  --out "$SIGNED" "$ALIGNED"

echo "Signed APK: $SIGNED"
ls -lh "$SIGNED"
