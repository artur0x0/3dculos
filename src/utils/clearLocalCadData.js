/**
 * clearLocalCadData — wipe device CAD caches without touching GitHub.
 *
 * Clears:
 *   - surfcad / editorDraft (+ localStorage surfcad_editor_draft fallback)
 *   - surfcad-assembly (document + part scripts)
 *   - SurfDB model cache (+ in-memory Manifold import cache)
 *   - OAuth editor hand-off localStorage (surfcad_editor) so a reload cannot
 *     resurrect the previous buffer
 *
 * Does not delete the GitHub account or vault repo. Does not clear the GitHub
 * OAuth token in sessionStorage — a same-tab reload keeps that token.
 */
import { clearEditorDraft } from './editorDraft.js';
import { clearAssemblyStore } from './assemblyStore.js';
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
