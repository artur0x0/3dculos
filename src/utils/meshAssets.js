/**
 * Local mesh assets for `importMesh('<Part>.mesh')`.
 *
 * Bytes live in the #288 cache (`putAsset` / `getAssetBytes`, IndexedDB
 * `surfcad-assets`, keyed by git blob sha). This module does not commit.
 * Git Save (`meshSync.js`) sends unsynced bytes and sets `meshSynced`
 * once that commit lands.
 */
import { nextNumberedName, sanitizePartName } from './assembly.js';
import { loadPartRecord } from './assemblyStore.js';
import { getAssetBytes } from './git/assetCache.js';
import { VAULT_FILE_MAX_BYTES, VAULT_FILE_WARN_BYTES } from './git/binaryContent.js';
import { decodeMesh } from './meshFormat.js';

const LEGACY_IMPORT = /window\.__importedManifolds\s*\[\s*['"]([^'"]+)['"]\s*\]/g;

/** Same names `parseImportedModels` finds. Kept here so this module can load in Node. */
function legacyImportNames(script) {
  const names = [];
  const pattern = new RegExp(LEGACY_IMPORT.source, 'g');
  let match = pattern.exec(String(script || ''));
  while (match) {
    names.push(match[1]);
    match = pattern.exec(String(script || ''));
  }
  return [...new Set(names)];
}

/** Reject the original file before it is parsed or sent to STEP conversion. */
export const RAW_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;

const memory = new Map();

function formatMiB(bytes) {
  const mib = (Number(bytes) || 0) / (1024 * 1024);
  const text = mib >= 10 ? mib.toFixed(0) : mib.toFixed(1);
  return `${text} MiB`;
}

export function normalizeAssetMap(assets) {
  const out = {};
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return out;
  for (const [name, sha] of Object.entries(assets)) {
    const key = String(name || '');
    const id = String(sha || '').toLowerCase();
    if (key && /^[0-9a-f]{40}$/.test(id)) out[key] = id;
  }
  return out;
}

/** In-memory copy so a run in the same turn does not wait on IndexedDB. */
export function rememberPartAssets(partId, assets) {
  memory.set(String(partId), normalizeAssetMap(assets));
}

export function forgetPartAssets(partId) {
  memory.delete(String(partId));
}

export async function assetsForPart(partId) {
  const key = String(partId || '');
  if (!key) return {};
  if (memory.has(key)) return memory.get(key);
  const record = await loadPartRecord(key);
  const assets = normalizeAssetMap(record?.assets);
  memory.set(key, assets);
  return assets;
}

export function checkRawUpload(byteLength) {
  const n = Number(byteLength) || 0;
  if (n > RAW_UPLOAD_MAX_BYTES) {
    return {
      ok: false,
      warn: false,
      message: `This file is ${formatMiB(n)}. Uploads must be 32 MiB or smaller.`,
    };
  }
  return { ok: true, warn: false, message: '' };
}

/** Caps for the stored `.mesh`, matching the vault file limits. */
export function checkStoredMesh(byteLength) {
  const n = Number(byteLength) || 0;
  if (n > VAULT_FILE_MAX_BYTES) {
    return {
      ok: false,
      warn: false,
      message: `The converted mesh is ${formatMiB(n)}. The limit is 40 MiB.`,
    };
  }
  if (n > VAULT_FILE_WARN_BYTES) {
    return {
      ok: true,
      warn: true,
      message: `This mesh is ${formatMiB(n)}. It is saved on this device and may be slow to sync.`,
    };
  }
  return { ok: true, warn: false, message: '' };
}

/** File stem, extension removed, made safe as a part name. */
export function partNameFromFile(filename) {
  const base = String(filename || '').replace(/^.*[/\\]/, '');
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return sanitizePartName(stem) || 'Import';
}

/**
 * `Bracket` when free, otherwise `Bracket (2)`, `Bracket (3)`, …
 * `taken` is the names already in the assembly.
 */
export function dedupedImportName(filename, taken) {
  return nextNumberedName(partNameFromFile(filename), taken, { bareFirst: true });
}

export function meshAssetName(partName) {
  return `${partName}.mesh`;
}

export function importMeshScript(assetName) {
  const safe = String(assetName).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `return importMesh('${safe}');\n`;
}

/** Asset names referenced by `importMesh('...')`. */
export function meshAssetNames(script) {
  const pattern = /\bimportMesh\s*\(\s*(['"])([^'"\\]+)\1\s*\)/g;
  const names = [];
  let match = pattern.exec(String(script || ''));
  while (match) {
    names.push(match[2]);
    match = pattern.exec(String(script || ''));
  }
  return [...new Set(names)];
}

/**
 * Resolve every mesh this script needs. `importMesh` names come from the
 * part's sha map and the asset cache. Legacy `__importedManifolds` names
 * still come from SurfDB. A missing `importMesh` name is listed; a missing
 * legacy file is left for the script, as before.
 */
export async function resolvePartMeshes(partId, script, deps = {}) {
  const assets = deps.assets || await assetsForPart(partId);
  const readBytes = deps.getAssetBytes || getAssetBytes;
  const importedModels = {};
  const missing = [];
  for (const name of meshAssetNames(script)) {
    const sha = assets?.[name];
    if (!sha) {
      missing.push(name);
      continue;
    }
    let bytes = null;
    try {
      bytes = await readBytes(sha);
    } catch {
      bytes = null;
    }
    if (!bytes) {
      missing.push(name);
      continue;
    }
    try {
      importedModels[name] = decodeMesh(bytes);
    } catch {
      missing.push(name);
    }
  }
  const legacyNames = legacyImportNames(script).filter((name) => !importedModels[name]);
  if (legacyNames.length) {
    let loadLegacy = deps.loadLegacy;
    if (!loadLegacy) {
      const mod = await import('./importModel.js');
      loadLegacy = mod.loadCachedModel;
    }
    for (const name of legacyNames) {
      try {
        const mesh = await loadLegacy(name);
        if (mesh?.vertProperties) importedModels[name] = mesh;
      } catch { /* legacy miss still runs the script */ }
    }
  }
  return { importedModels, missing };
}

export function missingMeshMessage(names) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return 'Missing mesh asset';
  return `Missing mesh asset: ${list.join(', ')}`;
}

/**
 * Quote failure for an `importMesh` the asset cache could not resolve.
 * A line that already failed keeps that message. Otherwise name the assets.
 */
export function meshResolveError(missing, lineError) {
  const text = typeof lineError === 'string' ? lineError.trim() : '';
  if (text && text !== 'failed' && text !== 'missing') return text;
  return missingMeshMessage(missing);
}

/**
 * 3MF of the selected row. Hidden and failed parts do not export.
 * A successful run wins; otherwise the leftover mesh. `needsRun` means
 * call `runAssemblyParts({ ids: [id] })` before giving up.
 */
export function selectedPartDownload({ part, run, leftover } = {}) {
  if (!part) return { ok: false, message: 'Select a part to download' };
  const name = part.name || 'part';
  if (part.visible === false) {
    return { ok: false, message: `${name} is hidden. Show it before downloading.` };
  }
  const failed = run && run.ok === false && !run.skipped && !run.empty;
  if (failed) {
    const why = run.error && run.error !== 'failed' && run.error !== 'missing'
      ? run.error
      : 'the script failed';
    return { ok: false, message: `${name} failed: ${why}` };
  }
  const live = run?.ok && run.mesh?.vertProperties ? run.mesh : null;
  const kept = leftover?.vertProperties ? leftover : null;
  const mesh = live || kept;
  if (mesh) return { ok: true, mesh, filename: name };
  return {
    ok: false,
    needsRun: true,
    filename: name,
    message: `No model to export for ${name}`,
  };
}

/**
 * Signed-in rows with a mesh that is not in the vault yet.
 * Signed-out work is always local, so it does not wear the badge.
 * `githubConnected` only changes the wording: a vault is waiting, or
 * GitHub still needs to reconnect. `meshSynced` clears the badge after Save.
 */
export function showLocalMeshBadge({ signedIn, meshLocal, meshSynced } = {}) {
  return signedIn === true && meshLocal === true && meshSynced !== true;
}

export function localMeshBadgeTitle(githubConnected) {
  return githubConnected
    ? 'Local only until synced to the vault'
    : 'Local only until GitHub is connected';
}
