import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const lock = src("velta-app/src-tauri/gen/android/app/src/main/java/org/velta/VeltaLock.kt");
const showLock = lock.slice(lock.indexOf("private fun showLock"), lock.indexOf("private fun hideLock"));
const colors = src("velta-app/src-tauri/gen/android/app/src/main/res/values/colors.xml");
const button = src("velta-app/src-tauri/gen/android/app/src/main/res/drawable/velta_primary_button.xml");

const value = name => {
  const match = new RegExp(`<color name="${name}">#([0-9A-Fa-f]{8})</color>`).exec(colors);
  assert.ok(match, `missing ${name}`);
  return match[1].slice(2);
};
const luminance = hex => {
  const rgb = hex.match(/.{2}/g).map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("native lock overlay uses Velta dark-theme tokens", () => {
  assert.match(showLock, /setBackgroundColor\(ContextCompat\.getColor\(activity, R\.color\.velta_bg\)\)/);
  assert.match(showLock, /setTextColor\(ContextCompat\.getColor\(activity, R\.color\.velta_text\)\)/);
  assert.doesNotMatch(showLock, /Color\.parseColor|Color\.WHITE/);
  assert.equal(value("velta_bg"), "0F0F14");
  assert.equal(value("velta_text"), "F2F2F5");
  assert.ok(contrast(value("velta_text"), value("velta_bg")) >= 4.5);
});

test("native lock overlay has restrained branding and design-system sizing", () => {
  assert.match(showLock, /setImageResource\(R\.mipmap\.ic_launcher\)/);
  assert.match(showLock, /LayoutParams\(dp\(56\), dp\(56\)\)/);
  assert.match(showLock, /bottomMargin = dp\(16\)/);
  assert.match(showLock, /textSize = 22f/);
  assert.match(showLock, /setPadding\(dp\(24\), dp\(24\), dp\(24\), dp\(24\)\)/);
  assert.match(showLock, /minOf\(activity\.resources\.displayMetrics\.widthPixels, dp\(360\)\)/);
});

test("native lock actions use the accent primary-button treatment", () => {
  assert.match(showLock, /b\.minHeight = dp\(48\)/);
  assert.match(showLock, /b\.textSize = 15f/);
  assert.match(showLock, /b\.setTextColor\(ContextCompat\.getColor\(activity, R\.color\.velta_on_accent\)\)/);
  assert.match(showLock, /b\.setBackgroundResource\(R\.drawable\.velta_primary_button\)/);
  assert.match(button, /android:radius="10dp"/);
  assert.match(button, /android:color="@color\/velta_accent"/);
  assert.equal(value("velta_accent"), "5AA2E6");
  assert.equal(value("velta_on_accent"), "10131A");
  assert.ok(contrast(value("velta_on_accent"), value("velta_accent")) >= 4.5);
});

test("lock-screen authentication behavior stays intact", () => {
  assert.match(showLock, /VeltaKeystore\.pinOn\(activity\)/);
  assert.match(showLock, /setOnClickListener \{ hideLock\(\) \}/);
  assert.match(showLock, /requestUnlock\(activity\)/);
});
