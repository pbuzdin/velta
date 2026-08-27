#!/bin/bash
# Sign an arbitrary unsigned APK with the Velta keystore.
# Usage: wsl.exe -- bash /mnt/c/Users/pave/Velta/velta/tools/sign-external-apk.sh /mnt/c/Users/pave/Velta/velta-1114-6-unsigned.apk
set -e

export JAVA_HOME=/home/pave/jdk/jdk-17
export ANDROID_HOME=/home/pave/android
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/build-tools/35.0.0:$PATH"

UNSIGNED="$1"
if [ -z "$UNSIGNED" ] || [ ! -f "$UNSIGNED" ]; then
    echo "Usage: $0 <unsigned-apk-path>"
    exit 1
fi

BASE="${UNSIGNED%_unsigned.apk}"
BASE="${BASE%.apk}"
ALIGNED="${BASE}-aligned.apk"
SIGNED="${BASE}-signed.apk"
KS=/home/pave/android/keystore/velta-debug.keystore

rm -f "$ALIGNED" "$SIGNED"

zipalign -p -f 4 "$UNSIGNED" "$ALIGNED"
apksigner sign --ks "$KS" --ks-pass pass:velta123 --key-pass pass:velta123 \
  --out "$SIGNED" "$ALIGNED"

apksigner verify --verbose "$SIGNED"
echo "Signed APK: $SIGNED"
ls -lh "$SIGNED"
