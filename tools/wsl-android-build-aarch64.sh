#!/bin/bash
# arm64-only APK: thin wrapper, the build lives in wsl-android-build.sh.
exec bash "$(dirname "$0")/wsl-android-build.sh" aarch64 "$@"
