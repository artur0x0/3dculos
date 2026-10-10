/**
 * Phone-path wasm memory ceiling.
 *
 * Both solver and mesher modules ship with non-shared memory. The solver's
 * memory has no maximum, and the mesher allows 2 GiB. On a phone the worker
 * rewrites the memory section so the maximum is 512 MiB and the shared bit
 * stays clear, then instantiates that copy. Desktop keeps the compiled limits.
 */

const PAGE = 65536;

function readLeb(bytes, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.length && shift <= 28) {
    const byte = bytes[cursor];
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: cursor };
    shift += 7;
  }
  throw new Error('truncated wasm integer');
}

function writeLeb(value) {
  const out = [];
  let rest = value >>> 0;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest) byte |= 0x80;
    out.push(byte);
  } while (rest);
  return out;
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

function isWasm(bytes) {
  return bytes.length >= 8
    && bytes[0] === 0x00
    && bytes[1] === 0x61
    && bytes[2] === 0x73
    && bytes[3] === 0x6d;
}

/**
 * Limits of the first memory.
 * `shared` is the threads flag. `maxPages` is null when the module has no maximum.
 */
export function wasmMemoryLimits(bytes) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isWasm(src)) throw new Error('not a wasm module');
  let offset = 8;
  while (offset < src.length) {
    const id = src[offset];
    const size = readLeb(src, offset + 1);
    const payloadEnd = size.next + size.value;
    if (payloadEnd > src.length) throw new Error('wasm section overruns the module');
    if (id === 5) {
      const payload = src.subarray(size.next, payloadEnd);
      const count = readLeb(payload, 0);
      if (!count.value) throw new Error('wasm module has an empty memory section');
      let cursor = count.next;
      const flags = readLeb(payload, cursor);
      cursor = flags.next;
      const min = readLeb(payload, cursor);
      cursor = min.next;
      let maxPages = null;
      if (flags.value & 1) {
        const max = readLeb(payload, cursor);
        maxPages = max.value;
      }
      return {
        shared: (flags.value & 2) !== 0,
        minPages: min.value,
        maxPages,
      };
    }
    offset = payloadEnd;
  }
  throw new Error('wasm module has no memory section');
}

function rewriteMemoryPayload(payload, maxPages) {
  const count = readLeb(payload, 0);
  const parts = [Uint8Array.from(writeLeb(count.value))];
  let cursor = count.next;
  for (let index = 0; index < count.value; index += 1) {
    const flags = readLeb(payload, cursor);
    cursor = flags.next;
    const min = readLeb(payload, cursor);
    cursor = min.next;
    let existingMax = null;
    if (flags.value & 1) {
      const max = readLeb(payload, cursor);
      cursor = max.next;
      existingMax = max.value;
    }
    let cap = maxPages;
    if (existingMax != null) cap = Math.min(cap, existingMax);
    if (cap < min.value) {
      throw new Error(`wasm memory minimum is ${min.value} pages, above the ${maxPages}-page ceiling`);
    }
    // Flag 1: minimum and maximum, not shared.
    parts.push(Uint8Array.from([
      ...writeLeb(1),
      ...writeLeb(min.value),
      ...writeLeb(cap),
    ]));
  }
  return concat(parts);
}

/**
 * Copy `bytes` with a non-shared memory whose maximum is at most
 * `ceilingBytes`, rounded up to a whole page. The compiled minimum is kept.
 */
export function capWasmMemory(bytes, ceilingBytes) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isWasm(src)) throw new Error('not a wasm module');
  if (!(ceilingBytes > 0)) throw new Error('memory ceiling must be positive');
  const maxPages = Math.max(1, Math.ceil(ceilingBytes / PAGE));
  const chunks = [src.subarray(0, 8)];
  let offset = 8;
  let patched = false;
  while (offset < src.length) {
    const id = src[offset];
    const size = readLeb(src, offset + 1);
    const payloadEnd = size.next + size.value;
    if (payloadEnd > src.length) throw new Error('wasm section overruns the module');
    if (id === 5) {
      const next = rewriteMemoryPayload(src.subarray(size.next, payloadEnd), maxPages);
      const sizeBytes = writeLeb(next.length);
      const header = new Uint8Array(1 + sizeBytes.length);
      header[0] = 5;
      header.set(sizeBytes, 1);
      chunks.push(header, next);
      patched = true;
    } else {
      chunks.push(src.subarray(offset, payloadEnd));
    }
    offset = payloadEnd;
  }
  if (!patched) throw new Error('wasm module has no memory section');
  return concat(chunks);
}

export const PHONE_WASM_BYTES = 512 * 1024 * 1024;

export function memoryIsShared(memory) {
  const buffer = memory && memory.buffer;
  return typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer;
}

/** `memory.buffer.byteLength`, or a raw byte count. */
export function wasmBufferBytes(memory) {
  if (typeof memory === 'number' && Number.isFinite(memory) && memory > 0) return memory;
  const buffer = memory && memory.buffer;
  const bytes = buffer && buffer.byteLength;
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

/**
 * `performance.memory.usedJSHeapSize` when that object exists.
 * Pass `null` to force zero. Omit the argument to read the global.
 */
export function performanceMemoryBytes(source) {
  if (source === null) return 0;
  const mem = source === undefined
    ? (typeof performance !== 'undefined' ? performance.memory : null)
    : source;
  if (!mem || typeof mem !== 'object') return 0;
  const used = Number(mem.usedJSHeapSize);
  return Number.isFinite(used) && used > 0 ? used : 0;
}

/**
 * One sample of worker memory: the largest wasm heap in `memories`, plus
 * `performance.memory` when it exists.
 */
export function workerMemorySample(memories, performanceMemory) {
  const list = Array.isArray(memories) ? memories : [memories];
  let wasm = 0;
  for (const memory of list) {
    const bytes = wasmBufferBytes(memory);
    if (bytes > wasm) wasm = bytes;
  }
  return wasm + performanceMemoryBytes(performanceMemory);
}

/** High-water mark. A missing sample does not lower the previous peak. */
export function nextPeakBytes(previous, sample) {
  const prior = Number(previous);
  const next = Number(sample);
  const kept = Number.isFinite(prior) && prior > 0 ? prior : 0;
  const seen = Number.isFinite(next) && next > 0 ? next : 0;
  return seen > kept ? seen : kept;
}
