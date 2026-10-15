#!/bin/bash
# arm64 APK signing: thin wrapper, the logic lives in wsl-android-sign.sh.
exec bash "$(dirname "$0")/wsl-android-sign.sh" aarch64 "$@"
