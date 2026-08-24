#!/bin/bash
set -e

source "$HOME/.cargo/env" 2>/dev/null || true

export JAVA_HOME=/home/pave/jdk/jdk-17
export ANDROID_HOME=/home/pave/android
export NDK_HOME=/home/pave/android/ndk/27.2.12479018
export NDK_TOOLCHAIN="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64"

# OpenSSL's configure script still invokes the legacy target-prefixed ranlib
# name, while modern NDKs only ship llvm-ranlib.  Use local compatibility
# shims and leave the NDK installation untouched.
TOOLCHAIN_SHIMS="$HOME/.cache/velta-android-toolchain-shims"
mkdir -p "$TOOLCHAIN_SHIMS"
ln -sf "$NDK_TOOLCHAIN/bin/llvm-ar" "$TOOLCHAIN_SHIMS/aarch64-linux-android-ar"
ln -sf "$NDK_TOOLCHAIN/bin/llvm-nm" "$TOOLCHAIN_SHIMS/aarch64-linux-android-nm"
ln -sf "$NDK_TOOLCHAIN/bin/llvm-ranlib" "$TOOLCHAIN_SHIMS/aarch64-linux-android-ranlib"

export PATH="$JAVA_HOME/bin:$TOOLCHAIN_SHIMS:$NDK_TOOLCHAIN/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# Cargo/NDK cross-compile vars for openssl-sys
export CC_aarch64_linux_android=aarch64-linux-android24-clang
export CXX_aarch64_linux_android=aarch64-linux-android24-clang++
export AR_aarch64_linux_android="$NDK_TOOLCHAIN/bin/llvm-ar"
export RANLIB_aarch64_linux_android="$NDK_TOOLCHAIN/bin/llvm-ranlib"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$NDK_TOOLCHAIN/bin/aarch64-linux-android24-clang"

# Override project cargo config Windows paths with WSL ones
cat > "$HOME/.cargo/config.toml" <<'EOF'
[target.aarch64-linux-android]
linker = "/home/pave/android/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang"
rustflags = ["-C", "link-arg=--target=aarch64-linux-android24"]

[target.armv7-linux-androideabi]
linker = "/home/pave/android/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/armv7a-linux-androideabi24-clang"
rustflags = ["-C", "link-arg=--target=armv7a-linux-androideabi24"]

[target.i686-linux-android]
linker = "/home/pave/android/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/i686-linux-android24-clang"
rustflags = ["-C", "link-arg=--target=i686-linux-android24"]

[target.x86_64-linux-android]
linker = "/home/pave/android/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android24-clang"
rustflags = ["-C", "link-arg=--target=x86_64-linux-android24"]
EOF

cd ~/velta/delta-web-app

# Avoid OpenSSL recursive-make clock-skew warnings when the checkout was copied
# from Windows into WSL with future-dated file mtimes.
find . -path './src-tauri/target' -prune -o -type f -exec touch {} +

echo "JAVA_HOME=$JAVA_HOME"
echo "ANDROID_HOME=$ANDROID_HOME"
echo "PATH first entries: $(echo $PATH | cut -d: -f1-3)"
echo "which java: $(which java)"
echo "which cargo: $(which cargo)"
echo "which llvm-ar: $(which llvm-ar)"
echo "which aarch64-linux-android-ranlib: $(which aarch64-linux-android-ranlib)"

cargo tauri android build --apk --target aarch64 "$@"
