// Database-encryption primitives for the PWA snapshot (#178 phase 3).
// Pure WebCrypto so the worker, the page and the Node tests share one
// implementation. At rest, every file in an OPFS snapshot generation is
// AES-256-GCM(DEK): "VLTE1" + version byte + 12-byte IV + ciphertext, with
// path|generation bound as AAD so bytes cannot be moved between files or
// generations. The DEK itself is stored only wrapped: AES-GCM(KEK) with a
// "VLTEW" header. The KEK comes from a passphrase (PBKDF2-SHA256) or a
// WebAuthn PRF passkey (HKDF over the prf bytes) — both derived on the
// page, which alone talks to navigator.credentials.

const enc = new TextEncoder();
const MAGIC_VLTE1 = enc.encode("VLTE1");
const MAGIC_VLTEW = enc.encode("VLTEW");
const VER = 1;

function u8Concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function subtle() {
  if (!globalThis.crypto?.subtle) throw new Error("WebCrypto unavailable");
  return globalThis.crypto.subtle;
}

async function aesKey(raw, extractable = false) {
  return subtle().importKey("raw", raw, "AES-GCM", extractable, ["encrypt", "decrypt"]);
}

async function gcm(key, iv, plain, aad) {
  const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plain);
  return new Uint8Array(ct);
}

async function gcmOpen(key, iv, blob, aad) {
  const pt = await subtle().decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, blob);
  return new Uint8Array(pt);
}

// Encrypt with the VLTE1 framing. `plain` is consumed by WebCrypto; a copy
// keeps repeat calls on the same buffer working.
export async function encryptFile(key, plain, aadText) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await gcm(key, iv, new Uint8Array(plain), enc.encode(aadText));
  return u8Concat(MAGIC_VLTE1, new Uint8Array([VER]), iv, ct);
}

export async function decryptFile(key, blob, aadText) {
  const head = MAGIC_VLTE1.length + 1;
  if (blob.length < head + 12 + 16 || !MAGIC_VLTE1.every((b, i) => blob[i] === b) || blob[MAGIC_VLTE1.length] !== VER) {
    throw new Error("not a VLTE1 payload");
  }
  const iv = blob.slice(MAGIC_VLTE1.length + 1, head + 12);
  return gcmOpen(key, iv, blob.slice(head + 12), enc.encode(aadText));
}

export function generateDek() {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

// Wrap the raw DEK with the KEK ("VLTEW" + version + IV + ciphertext).
export async function wrapDek(kekRaw, dek) {
  const key = await aesKey(kekRaw); // the DEK leaves as ciphertext only
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await gcm(key, iv, dek, enc.encode("dbkey.wrap"));
  return u8Concat(MAGIC_VLTEW, new Uint8Array([VER]), iv, ct);
}

export async function unwrapDek(kekRaw, blob) {
  const head = MAGIC_VLTEW.length + 1;
  if (blob.length < head + 12 + 32 + 16 || !MAGIC_VLTEW.every((b, i) => blob[i] === b) || blob[MAGIC_VLTEW.length] !== VER) {
    throw new Error("not a VLTEW payload");
  }
  const key = await aesKey(kekRaw);
  const iv = blob.slice(MAGIC_VLTEW.length + 1, head + 12);
  return gcmOpen(key, iv, blob.slice(head + 12), enc.encode("dbkey.wrap"));
}

// Passphrase KEK: PBKDF2-SHA256, WebCrypto-native (plan §2.3 fallback —
// the Argon2id upgrade is a separate wasm module if it is ever wanted).
export async function deriveKekPassphrase(passphrase, salt, iterations = 600_000) {
  const base = await subtle().importKey("raw", enc.encode(String(passphrase)), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    256,
  );
  return new Uint8Array(bits);
}

// Passkey KEK: HKDF-SHA256 over the prf eval bytes, so the KEK never
// equals the raw PRF output and is bound to this purpose.
export async function deriveKekPrf(prfBytes, salt) {
  const base = await subtle().importKey("raw", prfBytes, "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("velta-dbkey-v1") },
    base,
    256,
  );
  return new Uint8Array(bits);
}

// WebAuthn PRF: create a credential with the prf extension, then evaluate
// it. Both steps need a user gesture; both throw outside secure contexts or
// without platform support (Firefox desktop, older Safari — plan §2.3c).
export function prfSupported() {
  return !!globalThis.navigator?.credentials?.create && !!globalThis.isSecureContext;
}

export async function prfCreate(rpName) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: String(rpName || "Velta") },
      user: {
        id: globalThis.crypto.getRandomValues(new Uint8Array(16)),
        name: `velta-dbkey-${Date.now()}`,
        displayName: "Velta local encryption",
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: {} },
    },
  });
  return cred; // isPrfSupported read from cred.getClientExtensionResults() by the caller
}

export async function prfEval(credentialId, salt) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: credentialId }],
      userVerification: "required",
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const results = assertion.getClientExtensionResults?.()?.prf;
  const bytes = results?.results?.first;
  if (!bytes) throw new Error("authenticator did not return PRF bytes");
  return new Uint8Array(bytes);
}
