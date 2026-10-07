/**
 * Active-part script restore after IndexedDB hydrate.
 *
 * The editor draft is a single global buffer (crash/reload recovery). It must
 * only override the active part when the draft was saved for that part's id.
 * Otherwise a stale draft from FilletKilla (etc.) clobbers a newly created
 * cube part on leave/return — name stays, geometry swaps.
 */

/**
 * @param {{
 *   active: { id: string, name?: string },
 *   scripts: Record<string, string>,
 *   draft: { script: string, filename?: string|null, partId?: string|null }|null,
 *   fallbackScript?: string,
 * }} args
 * @returns {{
 *   script: string,
 *   filename: string|null,
 *   scripts: Record<string, string>,
 *   persistActive: boolean,
 *   fromDraft: boolean,
 * }}
 */
export function resolveActiveRestore({
  active,
  scripts = {},
  draft = null,
  fallbackScript = '',
} = {}) {
  const id = active?.id != null ? String(active.id) : null;
  const name = typeof active?.name === 'string' ? active.name : null;
  const saved = id && typeof scripts[id] === 'string' ? scripts[id] : null;
  const draftScript = typeof draft?.script === 'string' ? draft.script : null;
  const draftPartId = draft?.partId != null && String(draft.partId) !== ''
    ? String(draft.partId)
    : null;
  const draftFilename = typeof draft?.filename === 'string' && draft.filename
    ? draft.filename
    : null;
  const draftForActive = draftScript != null && draftPartId != null && id === draftPartId;

  if (draftForActive) {
    return {
      script: draftScript,
      filename: draftFilename || name,
      scripts: { ...scripts, [id]: draftScript },
      persistActive: saved !== draftScript,
      fromDraft: true,
    };
  }

  // Existing per-part bytes win over any unbound / other-part draft.
  if (saved != null) {
    return {
      script: saved,
      filename: name,
      scripts: { ...scripts },
      persistActive: false,
      fromDraft: false,
    };
  }

  // Empty active slot: legacy draft without partId may seed once.
  if (id && draftScript != null && draftPartId == null) {
    return {
      script: draftScript,
      filename: draftFilename || name,
      scripts: { ...scripts, [id]: draftScript },
      persistActive: true,
      fromDraft: true,
    };
  }

  const seed = typeof fallbackScript === 'string' ? fallbackScript : '';
  return {
    script: seed,
    filename: name,
    scripts: id ? { ...scripts, [id]: seed } : { ...scripts },
    persistActive: !!id,
    fromDraft: false,
  };
}

export default { resolveActiveRestore };
