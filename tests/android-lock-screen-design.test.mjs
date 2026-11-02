import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const lock = src("velta-app/src-tauri/gen/android/app/src/main/java/org/velta/VeltaLock.kt");
const showLock = lock.slice(lock.indexOf("private fun showLock"), lock.indexOf("private fun hideLock"));
const colors = src("velta-app/src-tauri/gen/android/app/src/main/res/values/colors.xml");
const strings = src("velta-app/src-tauri/gen/android/app/src/main/res/values/strings.xml");
const primaryButton = src("velta-app/src-tauri/gen/android/app/src/main/res/drawable/velta_primary_button.xml");
const secondaryButton = src("velta-app/src-tauri/gen/android/app/src/main/res/drawable/velta_secondary_button.xml");

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

test("native lock actions use distinct primary and secondary treatments", () => {
  assert.match(showLock, /b\.minHeight = dp\(48\)/);
  assert.match(showLock, /b\.textSize = 15f/);
  assert.match(showLock, /unlock\.setTextColor\(ContextCompat\.getColor\(activity, R\.color\.velta_on_accent\)\)/);
  assert.match(showLock, /unlock\.setBackgroundResource\(R\.drawable\.velta_primary_button\)/);
  assert.match(showLock, /usePin\.setTextColor\(ContextCompat\.getColor\(activity, R\.color\.velta_text\)\)/);
  assert.match(showLock, /usePin\.setBackgroundResource\(R\.drawable\.velta_secondary_button\)/);
  assert.match(primaryButton, /android:radius="10dp"/);
  assert.match(primaryButton, /android:color="@color\/velta_accent"/);
  assert.match(secondaryButton, /android:radius="10dp"/);
  assert.match(secondaryButton, /android:color="@color\/velta_bg_elev"/);
  assert.equal(value("velta_accent"), "5AA2E6");
  assert.equal(value("velta_on_accent"), "10131A");
  assert.equal(value("velta_bg_elev"), "1C1C26");
  assert.ok(contrast(value("velta_on_accent"), value("velta_accent")) >= 4.5);
  assert.ok(contrast(value("velta_text"), value("velta_bg_elev")) >= 4.5);
});

test("biometric action remains available after cancellation and handles retry", () => {
  assert.match(showLock, /R\.string\.biometric_unlock_action/);
  assert.match(showLock, /if \(VeltaCore\.running\(\)\) reAuth\(activity\) else requestUnlock\(activity\)/);
  assert.doesNotMatch(showLock, /visibility = View\.GONE[\s\S]*biometric_unlock_action/);
  assert.doesNotMatch(lock, /showRetry|biometric_retry/);
  assert.match(strings, /<string name="biometric_unlock_action">Unlock with biometrics<\/string>/);
});

test("PIN is a cold-start secondary action and cannot bypass auto-lock", () => {
  assert.match(showLock, /visibility = if \(allowPinFallback && VeltaKeystore\.pinOn\(activity\)\) View\.VISIBLE else View\.GONE/);
  assert.match(showLock, /setOnClickListener \{ hideLock\(\) \}/);
  assert.match(lock, /onActivityCreated[\s\S]*?showLock\(activity, allowPinFallback = !VeltaCore\.running\(\)\)[\s\S]*?requestUnlock\(activity\)/);
  assert.match(lock, /onActivityResumed[\s\S]*?showLock\(activity, allowPinFallback = false\)[\s\S]*?reAuth\(activity\)/);
  assert.match(strings, /<string name="biometric_use_pin">Use Velta PIN<\/string>/);
});
