// #138: load a built-in webxdc app for sending, and refuse to hand the core
// anything that is not a real .xdc (a zip carrying index.html). A bad file
// used to become an empty webxdc message whose frame showed "not found".

/** True when `bytes` is a zip whose central directory names index.html. */
export function isValidXdc(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 30) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) return false;
  const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);
  const u32 = (o) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 5 && bytes[i + 3] === 6) { eocd = i; break; }
  }
  if (eocd < 0) return false;
  let p = u32(eocd + 16);
  const want = "index.html";
  while (p + 46 <= eocd && u32(p) === 0x02014b50) {
    const n = u16(p + 28), x = u16(p + 30), c = u16(p + 32);
    if (p + 46 + n > bytes.length) return false;
    if (n === want.length) {
      let ok = true;
      for (let k = 0; k < n; k++) if (bytes[p + 46 + k] !== want.charCodeAt(k)) { ok = false; break; }
      if (ok) return true;
    }
    p += 46 + n + x + c;
  }
  return false;
}

/**
 * Return a core-readable path to the built-in app `name`, or throw.
 * Tauri (desktop + Android): the shell writes bytes bundled with
 * include_bytes! (prepare_builtin_xdc) — no asset fetch, no IPC byte body.
 * PWA: fetch from the origin, validate, then `writeFile(filename, bytes)`.
 */
export async function prepareBuiltinXdc(name, { invoke, fetchImpl, baseURI, writeFile } = {}) {
  if (invoke) {
    const path = await invoke("prepare_builtin_xdc", { name });
    if (!path) throw new Error("built-in app could not be prepared");
    return path;
  }
  const res = await fetchImpl(new URL(`builtin/${name}.xdc`, baseURI));
  if (!res.ok) throw new Error(`built-in app missing (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!isValidXdc(bytes)) throw new Error("built-in app is missing or damaged");
  return writeFile(`${name}-${Date.now()}.xdc`, bytes);
}
