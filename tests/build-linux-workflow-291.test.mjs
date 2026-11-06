import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("#291: manual Linux .deb workflow on ubuntu-24.04, not in release.yml", () => {
  const wf = readFileSync(new URL("../.github/workflows/build-linux.yml", import.meta.url), "utf8");
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /runs-on: ubuntu-24\.04/);
  assert.match(wf, /libwebkit2gtk-4\.1-dev/);
  assert.match(wf, /deltachat-rpc-server-x86_64-unknown-linux-gnu/);
  assert.match(wf, /tauri build --bundles deb,appimage/);
  assert.match(wf, /name: velta-linux-deb/);
  const rel = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.doesNotMatch(rel, /build-linux\.yml/);
});

test("#291: Linux bundles the sidecar as externalBin (installed next to the exe)", () => {
  const c = JSON.parse(readFileSync(new URL("../velta-app/src-tauri/tauri.linux.conf.json", import.meta.url), "utf8"));
  assert.equal(c.bundle.resources, null);
  assert.deepEqual(c.bundle.externalBin, ["binaries/deltachat-rpc-server"]);
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
