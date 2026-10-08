/**
 * Parts-list subtitle.
 *
 * A row whose id is already a repo path shows that path. Any other id
 * (a bare local key, or a legacy `local:` key) shows the path Add to Repo
 * would write: `parts/<Name>.js`, with `Name (2)` when that path is taken.
 * Nothing is shown when a path cannot be derived. The subtitle is not the
 * sync flag — Add to Repo is.
 */
import { sharedPathForMove } from './gitDeleteAssembly.js';
import { isVaultPartPath, vaultSegment } from './vaultLayout.js';

function nameBase(part) {
  return vaultSegment(String(part?.name || '').replace(/\.js$/i, '')) || 'Part';
}

/**
 * id → subtitle for one feed, in row order. Repo paths are reserved first
 * so an unsynced name does not pretend to be a file that is already a row.
 */
export function partListSubtitles(parts) {
  const taken = new Set();
  for (const part of parts || []) {
    const id = String(part?.id || '');
    if (isVaultPartPath(id)) taken.add(id);
  }
  const out = new Map();
  for (const part of parts || []) {
    const id = String(part?.id || '');
    if (!id) continue;
    if (isVaultPartPath(id)) {
      out.set(id, id);
      continue;
    }
    try {
      out.set(id, sharedPathForMove(nameBase(part), taken));
    } catch {
      out.set(id, '');
    }
  }
  return out;
}
