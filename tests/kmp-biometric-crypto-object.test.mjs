import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const base = "velta-kmp/composeApp/src/androidMain/kotlin/org/velta/kmp/";
const src = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const keystore = src(base + "core/VeltaKeystore.kt");
const main = src(base + "MainActivity.kt");
const platform = src(base + "CorePlatform.kt");

const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

test("the biometric KEK needs authentication for every use", () => {
  const gen = between(keystore, "private fun bioKekPerUse", "/** The cipher to put in");
  assert.match(gen, /setUserAuthenticationRequired\(true\)/);
  assert.match(gen, /setUserAuthenticationParameters\(\s*0,/);
  assert.match(gen, /setUserAuthenticationValidityDurationSeconds\(-1\)/);
  assert.match(gen, /BIO2_KEK_ALIAS/);
});

test("enable and unlock run through a CryptoObject prompt", () => {
  assert.match(main, /BiometricPrompt\.CryptoObject\(cipher\)/);
  assert.match(main, /result\.cryptoObject\?\.cipher/);
  assert.match(main, /VeltaKeystore\.enableCipher\(\)/);
  assert.match(main, /VeltaKeystore\.unlockCipher\(applicationContext\)/);
  // the key is used with the authenticated cipher, not by re-initialising one
  assert.match(keystore, /fun enableAppLock\(context: Context, dekHex: String, cipher: Cipher\)/);
  assert.match(platform, /VeltaKeystore\.takeCipher\(\) \?: return false/);
});

test("a changed biometric set falls back to the PIN", () => {
  assert.match(keystore, /fun dropInvalidatedBio/);
  assert.match(main, /catch \(e: android\.security\.keystore\.KeyPermanentlyInvalidatedException\)/);
  assert.match(main, /dropInvalidatedBio\(applicationContext\)/);
});

test("a wrap from older builds still opens, then is re-wrapped under the new key", () => {
  assert.match(keystore, /blob\[0\] == BIO_V_TIMED/);
  assert.match(main, /if \(!perUse\) upgradeBioWrap\(dek\)/);
});

test("a CryptoObject prompt never offers the device credential before API 30", () => {
  const policy = src("velta-kmp/composeApp/src/commonMain/kotlin/org/velta/kmp/ui/LockPolicy.kt");
  assert.match(policy, /withCrypto && sdk < 30 -> Authenticators\(strongBiometric = true, deviceCredential = false\)/);
});
