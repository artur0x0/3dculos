/**
 * clearLocalCadData — wipe device CAD caches without touching the remote repo.
 *
 * Clears:
 *   - surfcad / editorDraft (+ localStorage surfcad_editor_draft fallback)
 *   - surfcad-assembly (document + part scripts)
 *   - surfcad-sync (outbox + kv)
 *   - SurfDB model cache (+ in-memory Manifold import cache)
 *   - OAuth editor hand-off localStorage (surfcad_editor) so a reload cannot
 *     resurrect the previous buffer
 *
 * Kept: GitHub sessionStorage token (`surfcad.github.token`), the auth
 * session, the `surfcad-scs` catalog, and checkout / game-wins settings.
 * Does not delete the GitHub account or vault repo, and does not fetch.
 */
import { clearEditorDraft } from './editorDraft.js';
import { clearAssemblyStore } from './assemblyStore.js';
import { clearSyncStore } from './git/syncStore.js';
import { clearModelCache } from './importModel.js';
import { clearEditorState } from './editorStorage.js';

export async function clearLocalCadData() {
  const results = {
    editorDraft: false,
    assembly: false,
    modelCache: false,
    editorHandOff: false,
  };

  try {
    await clearEditorDraft();
    results.editorDraft = true;
  } catch (err) {
    console.warn('[ClearLocalCad] editorDraft:', err);
  }

  try {
    results.assembly = await clearAssemblyStore();
  } catch (err) {
    console.warn('[ClearLocalCad] assembly:', err);
  }

  try {
    await clearSyncStore();
    results.sync = true;
  } catch (err) {
    console.warn('[ClearLocalCad] sync:', err);
  }

  try {
    await clearModelCache();
    results.modelCache = true;
  } catch (err) {
    console.warn('[ClearLocalCad] modelCache:', err);
  }

  try {
    clearEditorState();
    results.editorHandOff = true;
  } catch (err) {
    console.warn('[ClearLocalCad] editorHandOff:', err);
  }

  return results;
}

export default { clearLocalCadData };
