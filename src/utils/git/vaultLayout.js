/**
 * Vault layout (one private repo per user, default `surfcad`):
 *
 *   surfcad.json                                  vault marker
 *   README.md
 *   assemblies/<name>/<name>.surf.json            assembly document
 *   assemblies/<name>/parts/<part>.js             that assembly's parts
 *   parts/<part>.js                               shared parts, referenced by path
 *
 * Every path here is repo-relative, forward-slash, no leading slash.
 * Part rows in a .surf.json reference scripts by these full repo paths.
 */
import { normalizeRepoPath } from '../assembly.js';

export const VAULT_MARKER_PATH = 'surfcad.json';
export const VAULT_README_PATH = 'README.md';
export const ASSEMBLIES_DIR = 'assemblies';
export const SHARED_PARTS_DIR = 'parts';
export const ASSEMBLY_EXT = '.surf.json';
export const PART_EXT = '.js';

/**
 * One path segment from an assembly or part name: no path or
 * Windows-illegal characters, no control characters, whitespace collapsed,
 * no leading/trailing dots, at most 60 characters. '' when nothing is left.
 */
export function vaultSegment(raw) {
  return String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim()
    .slice(0, 60)
    .trim();
}

function need(name, what) {
  const seg = vaultSegment(name);
  if (!seg) throw new Error(`Empty ${what} name`);
  return seg;
}

export function assemblyDir(assemblyName) {
  return `${ASSEMBLIES_DIR}/${need(assemblyName, 'assembly')}`;
}

export function assemblyFilePath(assemblyName) {
  const seg = need(assemblyName, 'assembly');
  return `${ASSEMBLIES_DIR}/${seg}/${seg}${ASSEMBLY_EXT}`;
}

export function assemblyPartsDir(assemblyName) {
  return `${assemblyDir(assemblyName)}/${SHARED_PARTS_DIR}`;
}

/** Strip a trailing `.js` so `Bracket` and `Bracket.js` name the same file. */
function partBase(partName) {
  return String(partName ?? '').replace(/\.js$/i, '');
}

export function assemblyPartPath(assemblyName, partName) {
  return `${assemblyPartsDir(assemblyName)}/${need(partBase(partName), 'part')}${PART_EXT}`;
}

export function sharedPartPath(partName) {
  return `${SHARED_PARTS_DIR}/${need(partBase(partName), 'part')}${PART_EXT}`;
}

/**
 * Classify a repo path:
 *   { kind: 'marker' }
 *   { kind: 'assembly', assembly }                 assemblies/A/A.surf.json
 *   { kind: 'assembly-part', assembly, part }      assemblies/A/parts/P.js
 *   { kind: 'shared-part', part }                  parts/P.js
 *   { kind: 'other' }                              anything else in the repo
 * null for a path normalizeRepoPath rejects.
 */
export function parseVaultPath(path) {
  const p = normalizeRepoPath(path);
  if (!p) return null;
  if (p === VAULT_MARKER_PATH) return { kind: 'marker' };
  const seg = p.split('/');
  if (seg.length === 2 && seg[0] === SHARED_PARTS_DIR && seg[1].endsWith(PART_EXT) && seg[1].length > PART_EXT.length) {
    return { kind: 'shared-part', part: seg[1].slice(0, -PART_EXT.length) };
  }
  if (seg[0] === ASSEMBLIES_DIR && seg.length === 3 && seg[2] === `${seg[1]}${ASSEMBLY_EXT}`) {
    return { kind: 'assembly', assembly: seg[1] };
  }
  if (seg[0] === ASSEMBLIES_DIR && seg.length === 4 && seg[2] === SHARED_PARTS_DIR
    && seg[3].endsWith(PART_EXT) && seg[3].length > PART_EXT.length) {
    return { kind: 'assembly-part', assembly: seg[1], part: seg[3].slice(0, -PART_EXT.length) };
  }
  return { kind: 'other' };
}

export function isAssemblyFile(path) {
  return parseVaultPath(path)?.kind === 'assembly';
}

export function isPartScript(path) {
  const k = parseVaultPath(path)?.kind;
  return k === 'assembly-part' || k === 'shared-part';
}

/**
 * May assembly `assemblyName` reference `path`? Its own parts and the
 * shared parts are allowed; another assembly's parts are not.
 */
export function partPathAllowedFor(assemblyName, path) {
  const info = parseVaultPath(path);
  if (!info) return false;
  if (info.kind === 'shared-part') return true;
  return info.kind === 'assembly-part' && info.assembly === vaultSegment(assemblyName);
}

/** Assembly names found in a listTree() result, sorted. */
export function listAssemblies(tree) {
  const out = [];
  for (const entry of tree || []) {
    const info = parseVaultPath(entry?.path ?? entry);
    if (info?.kind === 'assembly') out.push(info.assembly);
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

/** Part script paths in a listTree() result: { shared: [], byAssembly: { A: [] } }. */
export function listPartScripts(tree) {
  const shared = [];
  const byAssembly = {};
  for (const entry of tree || []) {
    const path = entry?.path ?? entry;
    const info = parseVaultPath(path);
    if (info?.kind === 'shared-part') shared.push(path);
    else if (info?.kind === 'assembly-part') (byAssembly[info.assembly] ||= []).push(path);
  }
  shared.sort();
  for (const k of Object.keys(byAssembly)) byAssembly[k].sort();
  return { shared, byAssembly };
}
