/**
 * Binary vault payloads.
 *
 * Text commits stay UTF-8 strings. A mesh is a Uint8Array (or ArrayBuffer /
 * Blob) and is stored as a Git blob with encoding base64. The local cache
 * key is the git blob sha: sha1("blob " + byteLength + NUL + bytes).
 *
 * GitHub rejects a blob at 100 MB. SurfCAD refuses earlier.
 */

/** Warn the caller above this size. The write still proceeds. */
export const VAULT_FILE_WARN_BYTES = 20 * 1024 * 1024;
/** Refuse a write above this size. */
export const VAULT_FILE_MAX_BYTES = 40 * 1024 * 1024;

export class VaultFileTooLargeError extends Error {
  /**
   * @param {string} path
   * @param {number} bytes
   */
  constructor(path, bytes) {
    const n = Number(bytes) || 0;
    super(`Vault file too large: ${path || '(unnamed)'} is ${n} bytes (limit ${VAULT_FILE_MAX_BYTES})`);
    this.name = 'VaultFileTooLargeError';
    this.code = 'file_too_large';
    this.path = path || '';
    this.bytes = n;
    this.limit = VAULT_FILE_MAX_BYTES;
  }
}

export function isBlobContent(content) {
  return typeof Blob !== 'undefined' && content instanceof Blob;
}

/** Uint8Array, ArrayBuffer, Buffer, or another typed array. Not a string. */
export function isBinaryContent(content) {
  if (content == null || typeof content === 'string') return false;
  if (isBlobContent(content)) return false;
  const Buf = globalThis.Buffer;
  if (typeof Buf !== 'undefined' && typeof Buf.isBuffer === 'function' && Buf.isBuffer(content)) {
    return true;
  }
  if (content instanceof ArrayBuffer) return true;
  return ArrayBuffer.isView(content) && !(content instanceof DataView);
}

export function utf8ByteLength(text) {
  const s = String(text ?? '');
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

export function byteLengthOf(content) {
  if (content == null) return 0;
  if (typeof content === 'string') return utf8ByteLength(content);
  if (isBlobContent(content)) return content.size;
  if (content instanceof ArrayBuffer) return content.byteLength;
  if (ArrayBuffer.isView(content)) return content.byteLength;
  return utf8ByteLength(String(content));
}

export function assertVaultFileSize(path, bytes) {
  const n = Number(bytes) || 0;
  if (n > VAULT_FILE_MAX_BYTES) throw new VaultFileTooLargeError(path, n);
  return n;
}

/** Copy binary content into a Uint8Array. */
export function toUint8Array(content) {
  if (content instanceof Uint8Array) return content.slice();
  if (content instanceof ArrayBuffer) return new Uint8Array(content.slice(0));
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength).slice();
  }
  throw new TypeError('Expected Uint8Array or ArrayBuffer');
}

export function encodeBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : toUint8Array(bytes);
  const Buf = globalThis.Buffer;
  if (typeof Buf !== 'undefined') return Buf.from(u8).toString('base64');
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function decodeBase64(b64) {
  const clean = String(b64 ?? '').replace(/\s/g, '');
  if (!clean) return new Uint8Array(0);
  const Buf = globalThis.Buffer;
  if (typeof Buf !== 'undefined') return new Uint8Array(Buf.from(clean, 'base64'));
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** SHA-1 of raw bytes, lowercase hex. Sync so commit planning stays sync. */
export function sha1Hex(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : toUint8Array(bytes);
  const bitLen = data.length * 8;
  const n = ((data.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(n);
  buf.set(data);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(n - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(n - 4, bitLen >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xEFCDAB89;
  let h2 = 0x98BADCFE;
  let h3 = 0x10325476;
  let h4 = 0xC3D2E1F0;
  const w = new Uint32Array(80);

  for (let i = 0; i < n; i += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(i + t * 4, false);
    for (let t = 16; t < 80; t += 1) {
      w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t += 1) {
      let f;
      let k;
      if (t < 20) {
        f = ((b & c) | (~b & d)) >>> 0;
        k = 0x5A827999;
      } else if (t < 40) {
        f = (b ^ c ^ d) >>> 0;
        k = 0x6ED9EBA1;
      } else if (t < 60) {
        f = ((b & c) | (b & d) | (c & d)) >>> 0;
        k = 0x8F1BBCDC;
      } else {
        f = (b ^ c ^ d) >>> 0;
        k = 0xCA62C1D6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[t]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/**
 * Git blob object id for `bytes`.
 * sha1( UTF-8("blob " + length + NUL) + bytes ).
 */
export function gitBlobSha(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : toUint8Array(bytes);
  const header = new TextEncoder().encode(`blob ${data.byteLength}\0`);
  const payload = new Uint8Array(header.length + data.byteLength);
  payload.set(header, 0);
  payload.set(data, header.length);
  return sha1Hex(payload);
}

export function bytesEqual(a, b) {
  if (a === b) return true;
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function coerceContent(content, encoding) {
  if (isBlobContent(content)) {
    return { binary: true, bytes: new Uint8Array(await content.arrayBuffer()) };
  }
  if (isBinaryContent(content)) {
    return { binary: true, bytes: toUint8Array(content) };
  }
  if (encoding === 'base64' && typeof content === 'string') {
    return { binary: true, bytes: decodeBase64(content) };
  }
  return { binary: false, text: content == null ? '' : String(content) };
}

/**
 * Normalize a commit file list. Text stays a string. Binary becomes a
 * Uint8Array copy. Throws VaultFileTooLargeError over 40 MiB.
 * -> { files, largeFiles: [{ path, bytes }] }
 */
export async function prepareCommitFiles(files) {
  const prepared = [];
  const largeFiles = [];
  for (const file of files || []) {
    const path = file?.path;
    if (file?.delete) {
      prepared.push({ path, delete: true });
      continue;
    }
    const coerced = await coerceContent(file?.content, file?.encoding);
    const n = coerced.binary ? coerced.bytes.byteLength : utf8ByteLength(coerced.text);
    assertVaultFileSize(path, n);
    const large = n > VAULT_FILE_WARN_BYTES;
    if (large) largeFiles.push({ path, bytes: n });
    if (coerced.binary) {
      prepared.push({
        path,
        content: coerced.bytes,
        encoding: 'base64',
        binary: true,
        ...(large ? { large: true } : {}),
      });
    } else {
      prepared.push({
        path,
        content: coerced.text,
        encoding: 'utf-8',
        binary: false,
        ...(large ? { large: true } : {}),
      });
    }
  }
  return { files: prepared, largeFiles };
}

/**
 * Outbox copy. Uint8Array and Blob stay bytes (Blob becomes Uint8Array).
 * A base64 string tagged encoding:'base64' is decoded. Text stays a string.
 */
export async function normalizeOutboxFiles(files) {
  if (!Array.isArray(files)) return files ?? null;
  const { files: prepared } = await prepareCommitFiles(files);
  return prepared.map((file) => {
    if (file.delete) return { path: file.path, delete: true };
    if (file.binary) {
      return {
        path: file.path,
        content: file.content,
        encoding: 'base64',
        ...(file.large ? { large: true } : {}),
      };
    }
    return {
      path: file.path,
      content: file.content,
      ...(file.large ? { large: true } : {}),
    };
  });
}
