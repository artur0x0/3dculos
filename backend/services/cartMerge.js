/**
 * Cart merge. No mongoose — root `test/cart-merge.test.js` imports this.
 *
 * Same lineId: later updatedAt wins. Equal timestamps keep the server line.
 * A line only on the server is kept. A line missing from the PUT is not a
 * delete. A tombstone drops a copy when deletedAt >= that copy's updatedAt.
 * updatedAt and deletedAt are clamped to server now + 5 minutes.
 * Tombstones older than 30 days are dropped, then the list is capped at 200
 * (oldest first). The merged cart is capped at 100 lines (newest kept);
 * overflow lines are tombstoned so they do not come back on the next put.
 */

export const MAX_CART_LINES = 100;
export const MAX_TOMBSTONES = 200;
export const THUMB_MAX_CHARS = 24_000;
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function stripThumb(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  if (url.length > THUMB_MAX_CHARS) return null;
  return url;
}

function parseIfMatch(header) {
  if (header == null || header === '') return { version: undefined };
  const raw = String(header).trim().replace(/^"|"$/g, '');
  if (!/^\d+$/.test(raw)) {
    return { error: 'If-Match must be the cart version' };
  }
  return { version: Number(raw) };
}

function requireText(value, label, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    return `${label} is required`;
  }
  if (value.length > max) return `${label} is too long`;
  return null;
}

/**
 * Validate a PUT body. Over-long thumbnails are stripped to null, not rejected.
 * More than 100 lines is rejected.
 */
export function validateCartPayload(body, ifMatchHeader) {
  const match = parseIfMatch(ifMatchHeader);
  if (match.error) return { ok: false, status: 400, error: match.error };

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Cart body is required' };
  }

  const baseVersion = body.baseVersion;
  if (typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 0) {
    return { ok: false, status: 400, error: 'baseVersion must be a non-negative integer' };
  }
  if (match.version !== undefined && match.version !== baseVersion) {
    return { ok: false, status: 400, error: 'If-Match does not match baseVersion' };
  }

  if (!Array.isArray(body.lines)) {
    return { ok: false, status: 400, error: 'lines must be an array' };
  }
  if (body.lines.length > MAX_CART_LINES) {
    return { ok: false, status: 400, error: `At most ${MAX_CART_LINES} cart lines` };
  }

  const tombstoneInput = body.tombstones == null ? [] : body.tombstones;
  if (!Array.isArray(tombstoneInput)) {
    return { ok: false, status: 400, error: 'tombstones must be an array' };
  }

  const seen = new Set();
  const lines = [];
  for (let i = 0; i < body.lines.length; i += 1) {
    const line = body.lines[i];
    const prepared = prepareLine(line, i);
    if (prepared.error) return { ok: false, status: 400, error: prepared.error };
    if (seen.has(prepared.line.lineId)) {
      return { ok: false, status: 400, error: `Duplicate line id ${prepared.line.lineId}` };
    }
    seen.add(prepared.line.lineId);
    lines.push(prepared.line);
  }

  const tombstones = [];
  for (let i = 0; i < tombstoneInput.length; i += 1) {
    const tomb = tombstoneInput[i];
    if (!tomb || typeof tomb !== 'object') {
      return { ok: false, status: 400, error: `Tombstone ${i} is invalid` };
    }
    if (!UUID_RE.test(String(tomb.lineId || ''))) {
      return { ok: false, status: 400, error: `Tombstone ${i} line id must be a uuid` };
    }
    const deletedAt = new Date(tomb.deletedAt);
    if (Number.isNaN(deletedAt.getTime())) {
      return { ok: false, status: 400, error: `Tombstone ${i} deletedAt is invalid` };
    }
    tombstones.push({ lineId: String(tomb.lineId), deletedAt: deletedAt.toISOString() });
  }

  return { ok: true, baseVersion, lines, tombstones };
}

function prepareLine(line, index) {
  if (!line || typeof line !== 'object') {
    return { error: `Line ${index} is invalid` };
  }
  if (!UUID_RE.test(String(line.lineId || ''))) {
    return { error: `Line ${index} line id must be a uuid` };
  }
  if (line.source !== 'local' && line.source !== 'git') {
    return { error: `Line ${index} source must be local or git` };
  }
  const fields = [
    requireText(line.assemblyName, `Line ${index} assembly`, 200),
    requireText(line.partId, `Line ${index} part id`, 500),
    requireText(line.partName, `Line ${index} part name`, 200),
    requireText(line.scriptHash, `Line ${index} scriptHash`, 128),
  ];
  const missing = fields.find(Boolean);
  if (missing) return { error: missing };

  const qty = line.qty;
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 999) {
    return { error: `Line ${index} qty must be an integer from 1 to 999` };
  }

  const addedAt = new Date(line.addedAt);
  const updatedAt = new Date(line.updatedAt);
  if (Number.isNaN(addedAt.getTime()) || Number.isNaN(updatedAt.getTime())) {
    return { error: `Line ${index} addedAt and updatedAt are required` };
  }

  let surfId = null;
  if (line.surfId != null && line.surfId !== '') {
    if (typeof line.surfId !== 'string' || line.surfId.length > 200) {
      return { error: `Line ${index} surf id is invalid` };
    }
    surfId = line.surfId;
  }

  let options = null;
  if (line.options != null) {
    if (typeof line.options !== 'object' || Array.isArray(line.options)) {
      return { error: `Line ${index} options must be an object` };
    }
    const infill = line.options.infill;
    options = {
      process: line.options.process == null ? null : String(line.options.process).slice(0, 32),
      material: line.options.material == null ? null : String(line.options.material).slice(0, 64),
      infill: Number.isFinite(Number(infill)) ? Number(infill) : null,
    };
  }

  return {
    line: {
      lineId: String(line.lineId),
      source: line.source,
      assemblyName: line.assemblyName,
      partId: line.partId,
      surfId,
      partName: line.partName,
      scriptHash: line.scriptHash,
      thumbDataUrl: stripThumb(line.thumbDataUrl),
      qty,
      options,
      addedAt: addedAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    },
  };
}

function asDate(value, fallback) {
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return new Date(fallback);
  return new Date(t);
}

function clampTime(value, nowMs, maxMs) {
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return new Date(nowMs);
  return new Date(Math.min(t, maxMs));
}

export function pruneTombstones(tombstones, now = new Date()) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const cutoff = nowMs - TOMBSTONE_TTL_MS;
  const fresh = [];
  for (const tomb of tombstones || []) {
    if (!tomb?.lineId) continue;
    const deletedAt = asDate(tomb.deletedAt, nowMs);
    if (deletedAt.getTime() < cutoff) continue;
    fresh.push({ lineId: String(tomb.lineId), deletedAt });
  }
  fresh.sort((a, b) => a.deletedAt - b.deletedAt);
  const capped = fresh.length > MAX_TOMBSTONES
    ? fresh.slice(fresh.length - MAX_TOMBSTONES)
    : fresh;
  return capped.map((tomb) => ({
    lineId: tomb.lineId,
    deletedAt: tomb.deletedAt.toISOString(),
  }));
}

function lineTime(line) {
  return new Date(line.updatedAt).getTime();
}

/**
 * @returns {{ version, lines, tombstones, merged }}
 */
export function mergeCart({
  serverLines = [],
  serverTombstones = [],
  serverVersion = 0,
  clientLines = [],
  clientTombstones = [],
  baseVersion = 0,
  now = new Date(),
}) {
  const clock = now instanceof Date ? now : new Date(now);
  const nowMs = clock.getTime();
  const maxMs = nowMs + CLOCK_SKEW_MS;

  const clampLine = (line) => ({
    ...line,
    thumbDataUrl: stripThumb(line.thumbDataUrl),
    addedAt: clampTime(line.addedAt, nowMs, maxMs).toISOString(),
    updatedAt: clampTime(line.updatedAt, nowMs, maxMs).toISOString(),
  });

  const tombs = new Map();
  const addTomb = (lineId, deletedAt) => {
    if (!lineId) return;
    const prev = tombs.get(lineId);
    if (!prev || deletedAt > prev) tombs.set(lineId, deletedAt);
  };
  for (const tomb of [...serverTombstones, ...clientTombstones]) {
    if (!tomb?.lineId) continue;
    addTomb(String(tomb.lineId), clampTime(tomb.deletedAt, nowMs, maxMs).getTime());
  }

  const byId = new Map();
  for (const line of serverLines) {
    if (!line?.lineId) continue;
    byId.set(String(line.lineId), { server: clampLine(line) });
  }
  for (const line of clientLines) {
    if (!line?.lineId) continue;
    const id = String(line.lineId);
    const entry = byId.get(id) || {};
    entry.client = clampLine(line);
    byId.set(id, entry);
  }

  const lines = [];
  for (const [lineId, sides] of byId) {
    const tombMs = tombs.has(lineId) ? tombs.get(lineId) : null;
    const live = [];
    if (sides.server && (tombMs == null || lineTime(sides.server) > tombMs)) live.push(sides.server);
    if (sides.client && (tombMs == null || lineTime(sides.client) > tombMs)) live.push(sides.client);
    if (live.length === 0) continue;

    let winner = live[0];
    if (sides.server && sides.client && lineTime(sides.server) === lineTime(sides.client)) {
      if (live.includes(sides.server)) winner = sides.server;
    } else {
      for (const candidate of live) {
        if (lineTime(candidate) > lineTime(winner)) winner = candidate;
      }
    }
    lines.push(winner);
  }

  if (lines.length > MAX_CART_LINES) {
    lines.sort((a, b) => lineTime(a) - lineTime(b));
    const drop = lines.splice(0, lines.length - MAX_CART_LINES);
    for (const line of drop) {
      addTomb(line.lineId, Math.max(lineTime(line), nowMs));
    }
  }

  const tombstones = pruneTombstones(
    [...tombs.entries()].map(([lineId, deletedAt]) => ({
      lineId,
      deletedAt: new Date(deletedAt).toISOString(),
    })),
    clock,
  );

  return {
    version: (Number(serverVersion) || 0) + 1,
    lines,
    tombstones,
    merged: baseVersion !== serverVersion,
  };
}
