/**
 * `.surf.json` — the assembly document as stored in the git vault
 * (nameless file at assemblies/<Name>/.surf.json).
 *
 * {
 *   "format": "surfcad.assembly",
 *   "version": 1,
 *   "name": "Gearbox",
 *   "activeId": "assemblies/Gearbox/Bracket.js" | null,
 *   "parts": [
 *     { "path": "assemblies/Gearbox/Bracket.js", "name": "Bracket",
 *       "visible": true, "order": 0, "position": [x, y, z]? },
 *     { "path": "parts/M3 bolt.js", "name": "M3 bolt", "visible": true, "order": 1 }
 *   ]
 * }
 *
 * `path` is a full repo path: this assembly's folder (next to `.surf.json`)
 * or the shared top-level `parts/`. Legacy `assemblies/<Name>/parts/<P>.js`
 * paths are accepted on read (read-compat); writers should emit the flat
 * layout. Path is also the row id in the in-app assembly document
 * (source 'git'). No script source in the file. Unknown top-level keys are
 * rejected so a typo cannot silently drop data.
 */
import { ASSEMBLY_VERSION, partPosition, serializeAssembly } from '../assembly.js';
import { normalizeRepoPath } from '../assembly.js';
import { PART_EXT, partPathAllowedFor, vaultSegment } from './vaultLayout.js';

export const SURF_JSON_FORMAT = 'surfcad.assembly';
export const SURF_JSON_VERSION = 1;
const TOP_KEYS = new Set(['format', 'version', 'name', 'activeId', 'parts']);
const PART_KEYS = new Set(['path', 'name', 'visible', 'order', 'position']);

/** { ok, errors: [string] } — every problem, not just the first. */
export function validateSurfJson(input) {
  const errors = [];
  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (err) {
      return { ok: false, errors: [`not JSON: ${err.message}`] };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['not an object'] };
  }
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) errors.push(`unknown key "${k}"`);
  if (raw.format !== SURF_JSON_FORMAT) errors.push(`format must be "${SURF_JSON_FORMAT}"`);
  if (raw.version !== SURF_JSON_VERSION) errors.push(`version must be ${SURF_JSON_VERSION}`);
  const name = typeof raw.name === 'string' ? raw.name : null;
  if (!name || !vaultSegment(name)) errors.push('name must be a non-empty string');
  else if (vaultSegment(name) !== name) errors.push(`name "${name}" is not path-safe`);
  if (!Array.isArray(raw.parts)) {
    errors.push('parts must be an array');
  } else {
    const seen = new Set();
    raw.parts.forEach((part, i) => {
      const at = `parts[${i}]`;
      if (!part || typeof part !== 'object' || Array.isArray(part)) {
        errors.push(`${at} must be an object`);
        return;
      }
      for (const k of Object.keys(part)) if (!PART_KEYS.has(k)) errors.push(`${at} unknown key "${k}"`);
      const path = normalizeRepoPath(part.path);
      if (!path || path !== part.path) errors.push(`${at}.path must be a repo-relative path`);
      else if (!path.endsWith(PART_EXT)) errors.push(`${at}.path must end in ${PART_EXT}`);
      else if (name && !partPathAllowedFor(name, path)) {
        errors.push(`${at}.path must be under assemblies/${name}/ or parts/`);
      }
      if (path && seen.has(path)) errors.push(`${at}.path duplicates ${path}`);
      if (path) seen.add(path);
      if (typeof part.name !== 'string' || !part.name.trim()) errors.push(`${at}.name must be a non-empty string`);
      if (typeof part.visible !== 'boolean') errors.push(`${at}.visible must be a boolean`);
      if (!Number.isInteger(part.order) || part.order < 0) errors.push(`${at}.order must be a non-negative integer`);
      if (part.position !== undefined && !partPosition(part)) errors.push(`${at}.position must be [x, y, z] numbers`);
    });
    if (raw.activeId != null && !seen.has(raw.activeId)) errors.push('activeId must be null or one of the part paths');
  }
  if (raw.activeId !== undefined && raw.activeId !== null && typeof raw.activeId !== 'string') {
    errors.push('activeId must be a string or null');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * In-app assembly document -> .surf.json object. Row ids must already be
 * repo paths (git mode). Throws when the result does not validate.
 */
export function toSurfJson(doc) {
  const flat = serializeAssembly({ ...doc, source: 'git' });
  const name = vaultSegment(flat.name);
  const out = {
    format: SURF_JSON_FORMAT,
    version: SURF_JSON_VERSION,
    name,
    activeId: flat.activeId,
    parts: flat.parts.map((p) => {
      const row = { path: p.id, name: p.name, visible: p.visible, order: p.order };
      if (p.position) row.position = p.position;
      return row;
    }),
  };
  const check = validateSurfJson(out);
  if (!check.ok) throw new Error(`Invalid .surf.json: ${check.errors.join('; ')}`);
  return out;
}

/** Stable text for a commit: 2-space indent, trailing newline. */
export function stringifySurfJson(doc) {
  return `${JSON.stringify(toSurfJson(doc), null, 2)}\n`;
}

/** .surf.json text or object -> in-app assembly document (source 'git'). Throws on invalid. */
export function parseSurfJson(input) {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  const check = validateSurfJson(raw);
  if (!check.ok) throw new Error(`Invalid .surf.json: ${check.errors.join('; ')}`);
  return serializeAssembly({
    version: ASSEMBLY_VERSION,
    source: 'git',
    name: raw.name,
    activeId: raw.activeId,
    parts: raw.parts.map((p) => ({
      id: p.path, name: p.name, visible: p.visible, order: p.order, position: p.position,
    })),
  });
}
