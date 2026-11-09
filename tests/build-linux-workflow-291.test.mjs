import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("#291: Linux .deb workflow in Debian 12, attached by release.yml", () => {
  const wf = readFileSync(new URL("../.github/workflows/build-linux.yml", import.meta.url), "utf8");
  assert.match(wf, /workflow_call:/);
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /container: debian:12/);
  assert.match(wf, /shared-key: debian12-glibc236/);
  assert.match(wf, /key: sidecar-linux-debian12-glibc236/);
  assert.match(wf, /python3 tools\/check-glibc\.py 2\.36 \/tmp\/deb-root \/tmp\/squashfs-root/);
  assert.match(wf, /APPIMAGE_EXTRACT_AND_RUN: 1/);
  assert.match(wf, /libwebkit2gtk-4\.1-dev/);
  assert.match(wf, /velta-rpc-server-x86_64-unknown-linux-gnu/);
  assert.match(wf, /tauri build --bundles deb,appimage/);
  assert.match(wf, /name: velta-linux-deb/);
  const rel = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(rel, /uses: \.\/\.github\/workflows\/build-linux\.yml/);
  assert.match(rel, /needs: \[android, windows, macos, linux\]/);
  for (const name of ["velta-linux-deb", "velta-linux-appimage", "velta-arch-pkg"]) {
    assert.match(rel, new RegExp(`name: ${name}`));
  }
  assert.match(rel, /glibc 2\.36\+/);
  assert.match(rel, /Ubuntu 23\.04\+/);
  assert.match(rel, /Linux self-update is not wired/);
});

test("#291: Linux bundles the sidecar as externalBin (installed next to the exe)", () => {
  const c = JSON.parse(readFileSync(new URL("../velta-app/src-tauri/tauri.linux.conf.json", import.meta.url), "utf8"));
  assert.equal(c.bundle.resources, null);
  assert.deepEqual(c.bundle.externalBin, ["binaries/velta-rpc-server"]);
});

test("#291: AppImage + Arch package (velta-bin PKGBUILD repackages the .deb)", () => {
  const wf = readFileSync(new URL("../.github/workflows/build-linux.yml", import.meta.url), "utf8");
  assert.match(wf, /name: velta-linux-appimage/);
  assert.match(wf, /container: archlinux:base-devel/);
  assert.match(wf, /su builder -c "cd \/tmp\/pkg && makepkg/);
  assert.match(wf, /name: velta-arch-pkg/);
  const pb = readFileSync(new URL("../packaging/arch/PKGBUILD", import.meta.url), "utf8");
  assert.match(pb, /^pkgname=velta-bin$/m);
  assert.match(pb, /webkit2gtk-4\.1/);
  assert.match(pb, /bsdtar -xf "\$data" -C "\$pkgdir"/);
});

test("#295: Linux core is velta-rpc-server; PKGBUILD has no provides/conflicts; CI checks lists", () => {
  const pb = readFileSync(new URL("../packaging/arch/PKGBUILD", import.meta.url), "utf8");
  assert.doesNotMatch(pb, /^(provides|conflicts)=/m);
  const sc = readFileSync(new URL("../velta-app/src-tauri/src/sidecar.rs", import.meta.url), "utf8");
  assert.match(sc, /not\(any\(target_os = "macos", target_os = "android"\)\)\)\)\]\nconst SIDECAR_NAME: &str = "velta-rpc-server";/);
  assert.match(sc, /#\[cfg\(target_os = "macos"\)\]\nconst SIDECAR_NAME: &str = "deltachat-rpc-server";/);
  const wf = readFileSync(new URL("../.github/workflows/build-linux.yml", import.meta.url), "utf8");
  assert.equal((wf.match(/! grep -q 'deltachat-rpc-server'/g) || []).length, 3);
  assert.match(wf, /pacman -S --noconfirm deltachat-rpc-server/);
});
