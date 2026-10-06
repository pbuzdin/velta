// V2.5 identity backup bundle (Architecture C, spike days 17/20). The wasm
// core's memfs holds the armored self-key files (export_self_keys writes a
// DIRECTORY of them); this module wraps those + the relay credentials into
// one passphrase-encrypted file the user can keep anywhere (storage-eviction
// hedge — OPFS can be wiped, a downloaded file can't).
//
// Crypto: WebCrypto AES-GCM-256 over a JSON payload, key = PBKDF2-SHA-256
// (310,000 iterations) from the user passphrase. The SAME passphrase also
// protects the key files inside the core (export/import_self_keys), so the
// user only ever remembers one secret.
//
// File layout: MAGIC | salt(16) | iv(12) | AES-GCM ciphertext(JSON).
// Node-testable: no DOM, only WebCrypto + btoa/atob + TextEncoder.

const MAGIC = "VeltaIdentity-v1";
const PBKDF2_ITERATIONS = 310_000;

async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

// bundle: { kind, v, addr, mail_pw, keys: { filename: base64 }, exported } —
// see buildIdentityBundle; this function accepts any JSON-able object.
export async function wrapIdentityBundle(bundle, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(bundle))),
  );
  const magic = new TextEncoder().encode(MAGIC);
  const out = new Uint8Array(magic.length + salt.length + iv.length + ciphertext.length);
  out.set(magic, 0);
  out.set(salt, magic.length);
  out.set(iv, magic.length + salt.length);
  out.set(ciphertext, magic.length + salt.length + iv.length);
  return out;
}

export async function unwrapIdentityBundle(bytes, passphrase) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const magic = new TextEncoder().encode(MAGIC);
  if (bytes.length < magic.length + 28 || !magic.every((b, i) => bytes[i] === b)) {
    throw new Error("Not a Velta identity backup file");
  }
  const salt = bytes.subarray(magic.length, magic.length + 16);
  const iv = bytes.subarray(magic.length + 16, magic.length + 28);
  const ciphertext = bytes.subarray(magic.length + 28);
  const key = await deriveKey(passphrase, salt);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)));
  } catch {
    throw new Error("Wrong passphrase or corrupted backup");
  }
  if (parsed?.kind !== "velta-identity" || !parsed.addr || !parsed.mail_pw || typeof parsed.keys !== "object") {
    throw new Error("Identity backup is missing required fields");
  }
  return parsed;
}

// The core's imex layer: export_self_keys writes armored files into a memfs
// DIRECTORY; import_self_keys reads them back the same way (spike day 18 —
// paths are directories, not tars). Keys ride the bundle base64-encoded.
export function buildIdentityBundle({ addr, mail_pw, keys }) {
  return { kind: "velta-identity", v: 1, addr, mail_pw, keys, exported: new Date().toISOString() };
}

export function bytesToBase64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
