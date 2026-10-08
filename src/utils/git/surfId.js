/**
 * Stable part identity.
 *
 * Format (UTC): yyyy-mm-dd-hh-mm-ss-SSSS-<4 hex>
 *   2026-10-07-20-56-31-0423-a3f9
 * A part created locally and not yet pushed is `local-` + that id.
 * The first successful push drops the prefix in the same commit.
 *
 * The id lives as the first line of the part script:
 *   // @surf-id <id>
 * `.surf.json` stores `{ id, path }`. The row id in the app stays the path
 * so scripts stay keyed by file. Blob SHA is never an identity.
 */

const SURF_ID_BODY = String.raw`\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{4}-[0-9a-f]{4}`;
export const SURF_ID_RE = new RegExp(`^(?:local-)?${SURF_ID_BODY}$`);
const HEADER_RE = /^\/\/ @surf-id (\S+)\s*(?:\r?\n)?/;

export function isSurfId(value) {
  return SURF_ID_RE.test(String(value || ''));
}

export function isLocalSurfId(value) {
  return isSurfId(value) && String(value).startsWith('local-');
}

/** Drop a `local-` prefix. Already-promoted ids pass through. */
export function promoteSurfId(value) {
  const id = String(value || '');
  return id.startsWith('local-') ? id.slice('local-'.length) : id;
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function randomHex4() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(2);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
}

/**
 * Mint an id. `now` is a Date or epoch ms (tests pin it).
 * `rand` is 4 hex chars (tests pin it); otherwise random.
 * `local` prefixes `local-` for a part that has not been pushed.
 */
export function mintSurfId({ local = false, now = new Date(), rand } = {}) {
  const date = now instanceof Date ? now : new Date(now);
  const stamp = [
    pad(date.getUTCFullYear(), 4),
    pad(date.getUTCMonth() + 1, 2),
    pad(date.getUTCDate(), 2),
    pad(date.getUTCHours(), 2),
    pad(date.getUTCMinutes(), 2),
    pad(date.getUTCSeconds(), 2),
    pad(date.getUTCMilliseconds(), 4),
  ].join('-');
  const hex = String(rand != null ? rand : randomHex4())
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '')
    .padStart(4, '0')
    .slice(0, 4);
  const body = `${stamp}-${hex}`;
  return local ? `local-${body}` : body;
}

/** Id from the first line, or null when the header is missing or invalid. */
export function readSurfId(script) {
  const match = HEADER_RE.exec(String(script ?? ''));
  if (!match || !isSurfId(match[1])) return null;
  return match[1];
}

/** Script text with the surf-id header removed. */
export function stripSurfId(script) {
  return String(script ?? '').replace(HEADER_RE, '');
}

/** First line is `// @surf-id <id>`. Replaces an existing header. */
export function withSurfId(script, id) {
  if (!isSurfId(id)) throw new Error(`Bad surf id: ${id}`);
  const body = stripSurfId(script);
  const sep = body.length && !body.startsWith('\n') ? '\n' : '';
  return `// @surf-id ${id}${sep}${body}`;
}

/**
 * Add to Repo is only for parts that have never been pushed:
 * a `local-` surf id, or a legacy `local:` / `local-` row id.
 * An in-repo path (including a link to another assembly) does not qualify.
 */
export function showAddToRepo(part) {
  if (!part) return false;
  if (isLocalSurfId(part.surfId)) return true;
  const id = String(part.id || '');
  return id.startsWith('local:') || id.startsWith('local-');
}

/**
 * Assign a stable id to every part that lacks one.
 * Header wins, then an existing surfId, then the path index, then a new id.
 * Does not rewrite script text (that happens on the next save / push).
 * Idempotent: a second call with the returned index mints nothing.
 * -> { doc, index, minted }
 */
export function backfillSurfIds(doc, pathIndex = {}, { now, randFor } = {}) {
  const index = { ...(pathIndex || {}) };
  let minted = 0;
  const parts = (doc?.parts || []).map((part, i) => {
    const path = String(part?.id || '');
    if (part?.surfId && isSurfId(part.surfId)) {
      if (path) index[path] = part.surfId;
      return part;
    }
    const cached = path && index[path];
    if (cached && isSurfId(cached)) {
      return { ...part, surfId: cached };
    }
    const id = mintSurfId({
      local: false,
      now,
      rand: typeof randFor === 'function' ? randFor(part, i) : undefined,
    });
    if (path) index[path] = id;
    minted += 1;
    return { ...part, surfId: id };
  });
  return { doc: { ...doc, parts }, index, minted };
}

/** Header wins over a stored surfId when the script already carries one. */
export function surfIdFromScript(part, script) {
  const header = readSurfId(script);
  if (header) return header;
  if (part?.surfId && isSurfId(part.surfId)) return part.surfId;
  return null;
}

/**
 * Replace `local-` ids in part headers and `.surf.json` part.id fields.
 * `map` is filled with localId → promoted id. Files with no local id are
 * returned unchanged (same array when nothing promoted).
 */
export function promoteFiles(files) {
  const list = Array.isArray(files) ? files : [];
  const map = new Map();
  let touched = false;
  const next = list.map((file) => {
    if (!file || file.delete || typeof file.content !== 'string') return file;
    if (!String(file.path || '').endsWith('.js')) return file;
    const id = readSurfId(file.content);
    if (!id || !isLocalSurfId(id)) return file;
    const promoted = promoteSurfId(id);
    map.set(id, promoted);
    touched = true;
    return { ...file, content: withSurfId(file.content, promoted) };
  });
  if (!map.size) return { files: list, map: {} };
  const rewritten = next.map((file) => {
    if (!file || file.delete || typeof file.content !== 'string') return file;
    if (!isSurfJsonPath(file.path)) return file;
    const content = rewriteSurfIdFields(file.content, map);
    if (content !== file.content) touched = true;
    return content === file.content ? file : { ...file, content };
  });
  return { files: touched ? rewritten : list, map: Object.fromEntries(map) };
}

export function isSurfJsonPath(path) {
  return String(path || '').endsWith('/.surf.json') || String(path || '').endsWith('.surf.json');
}

/** Rewrite part.id values in a `.surf.json` text. Unknown JSON is returned as-is. */
export function rewriteSurfIdFields(text, map) {
  if (!map || (typeof map.size === 'number' ? map.size === 0 : !Object.keys(map).length)) {
    return text;
  }
  const get = (id) => (map instanceof Map ? map.get(id) : map[id]);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return text;
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.parts)) return text;
  let changed = false;
  for (const part of raw.parts) {
    const next = get(part?.id);
    if (next && next !== part.id) {
      part.id = next;
      changed = true;
    }
    const copied = get(part?.copiedFrom);
    if (copied && copied !== part.copiedFrom) {
      part.copiedFrom = copied;
      changed = true;
    }
  }
  if (Array.isArray(raw.groups)) {
    for (const group of raw.groups) {
      if (!Array.isArray(group?.partIds)) continue;
      group.partIds = group.partIds.map((id) => {
        const next = get(id);
        if (next && next !== id) {
          changed = true;
          return next;
        }
        return id;
      });
    }
  }
  if (!changed) return text;
  return `${JSON.stringify(raw, null, 2)}\n`;
}

/** Apply a localId → repo id map to the working copy (row surfId + script header). */
export function applyIdPromotion(doc, scripts, map) {
  const table = map instanceof Map ? Object.fromEntries(map) : (map || {});
  const keys = Object.keys(table);
  if (!keys.length) return { doc, scripts: scripts || {}, changed: false };
  const parts = (doc?.parts || []).map((part) => {
    const next = table[part?.surfId];
    const copied = table[part?.copiedFrom];
    if (!next && !copied) return part;
    return {
      ...part,
      ...(next ? { surfId: next } : {}),
      ...(copied ? { copiedFrom: copied } : {}),
    };
  });
  const groups = Array.isArray(doc?.groups)
    ? doc.groups.map((group) => ({
      ...group,
      partIds: (group.partIds || []).map((id) => table[id] || id),
    }))
    : doc?.groups;
  const nextScripts = {};
  for (const [path, text] of Object.entries(scripts || {})) {
    const id = readSurfId(text);
    nextScripts[path] = id && table[id] ? withSurfId(text, table[id]) : text;
  }
  return {
    doc: { ...doc, parts, ...(Array.isArray(groups) ? { groups } : {}) },
    scripts: nextScripts,
    changed: true,
  };
}
