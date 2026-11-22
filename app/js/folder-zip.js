// folder-zip.js — #454: zip a picked folder (webkitdirectory FileList) into
// a single archive for the p2p transfer, and unzip a received one. STORE
// entries only: media/photos are already compressed, so deflate buys ~noth-
// ing and costs CPU; the format is still a standard zip any tool opens.
// Both directions are small, deliberate, dependency-free implementations.

// CRC-32 (IEEE), table-driven — the only checksum the zip format requires.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const dosDateTime = (d = new Date()) => {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
};

// DOS names are CP437-ish; UTF-8 names are the portable default — set the
// language encoding flag (bit 11) so every modern unzipper reads them right.
const UTF8_FLAG = 0x0800;

/**
 * Builds a zip (STORE) from `{ name, relativePath, lastModified }` entries
 * whose bytes are read through `read(entry) -> Promise<Uint8Array>`.
 * `relativePath` uses forward slashes and must not start with "/" or "..".
 * Returns a Blob. Progress fires with (doneEntries, totalEntries).
 */
export async function zipFolder(entries, read, onProgress = null) {
  const parts = [];
  const central = [];
  let offset = 0;
  let done = 0;
  const total = entries.length;
  const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
  const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

  for (const entry of entries) {
    // relativePath is the contract (the shell's walk provides it); name is
    // NOT a fallback — an entry without a relative path is skipped, since a
    // bare name would flatten the folder structure the transfer carries.
    if (!entry.relativePath) { done++; continue; }
    const rel = String(entry.relativePath)
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .split("/")
      .reduce((acc, seg) => {
        if (!seg || seg === ".") return acc;
        if (seg === "..") return acc.slice(0, -1); // resolve, don't drop
        return [...acc, seg];
      }, [])
      .join("/");
    if (!rel) { done++; continue; }
    const nameBytes = new TextEncoder().encode(rel);
    const { time, date } = dosDateTime(entry.lastModified ? new Date(entry.lastModified) : undefined);
    const data = await read(entry);
    const crc = crc32(data);
    const size = data.length;

    const local = [
      ...u32(0x04034B50), ...u16(20), ...u16(UTF8_FLAG), ...u16(0),
      ...u16(time), ...u16(date), ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(0),
    ];
    const localHeader = new Uint8Array([...local, ...nameBytes]);
    parts.push(localHeader, data);

    central.push([
      ...u32(0x02014B50), ...u16(20), ...u16(20), ...u16(UTF8_FLAG), ...u16(0),
      ...u16(time), ...u16(date), ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset), ...nameBytes,
    ]);
    offset += localHeader.length + size;
    done++;
    onProgress?.(done, total);
  }

  const centralBytes = central.flat();
  const end = [
    ...u32(0x06054B50), ...u16(0), ...u16(0),
    ...u16(central.length), ...u16(central.length),
    ...u32(centralBytes.length), ...u32(offset), ...u16(0),
  ];
  return new Blob([...parts, new Uint8Array(centralBytes), new Uint8Array(end)],
    { type: "application/zip" });
}

/**
 * Reads a STORE zip back: `{ [relativePath]: Uint8Array }`. Entries using
 * deflate are rejected (we only produce STORE; third-party zips with
 * deflate are rare for this flow and the OS extractor handles them).
 * Malformed central directory or path escapes throw.
 */
export async function unzipToMap(bytes) {
  const u16 = (b, i) => b[i] | (b[i + 1] << 8);
  const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  // End of central directory: scan back for the signature (a zip comment
  // may follow it).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65558; i--) {
    if (u32(bytes, i) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = u16(bytes, eocd + 10);
  let ptr = u32(bytes, eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (u32(bytes, ptr) !== 0x02014B50) throw new Error("corrupt zip central directory");
    const method = u16(bytes, ptr + 10);
    const crc = u32(bytes, ptr + 16);
    const size = u32(bytes, ptr + 24);
    const nameLen = u16(bytes, ptr + 28);
    const extraLen = u16(bytes, ptr + 30);
    const commentLen = u16(bytes, ptr + 32);
    const localOffset = u32(bytes, ptr + 42);
    const name = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;
    if (method !== 0) throw new Error(`unsupported compression (entry ${name})`);
    if (/^(\/|\.\.\/|[A-Za-z]:)/.test(name) || name.includes("../")) {
      throw new Error(`unsafe path in zip: ${name}`);
    }
    const localNameLen = u16(bytes, localOffset + 26);
    const localExtraLen = u16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.subarray(dataStart, dataStart + size);
    if (crc32(data) !== crc) throw new Error(`corrupt zip entry: ${name}`);
    out[name] = new Uint8Array(data);
  }
  return out;
}
