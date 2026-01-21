// utils/editorStorage.js - Save and restore editor state across OAuth redirects

const STORAGE_KEY = 'surfcad_editor';

/**
 * Save editor state before OAuth redirect or navigation
 * @param {Object} state - Editor state to save
 */
export function saveEditorState(state) {
  try {
    const { currentScript, currentFilename } = state;

    console.log('[EditorStorage] Attempting to save:', {
      hasScript: !!currentScript,
      scriptLength: currentScript?.length,
      currentFilename,
    });

    const serialized = {
      currentScript,
      currentFilename,
      savedAt: Date.now(),
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized));
    
    // Verify it was saved
    const verified = localStorage.getItem(STORAGE_KEY);
    console.log('[EditorStorage] Save verified:', !!verified);
    
    return true;
  } catch (err) {
    console.error('[EditorStorage] Failed to save state:', err);
    return false;
  }
}

/**
 * Restore editor state after OAuth redirect
 * @returns {Object|null} Restored state or null
 */
export function restoreEditorState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    
    console.log('[EditorStorage] Attempting restore, found in storage:', !!stored);
    
    if (!stored) {
      return null;
    }

    const parsed = JSON.parse(stored);
    
    console.log('[EditorStorage] Parsed state:', {
      hasScript: !!parsed.currentScript,
      scriptLength: parsed.currentScript?.length,
      currentFilename: parsed.currentFilename,
      savedAt: parsed.savedAt,
      ageMs: Date.now() - parsed.savedAt,
    });
    
    // Check if state is too old (> 1 hour)
    const maxAge = 60 * 60 * 1000;
    if (Date.now() - parsed.savedAt > maxAge) {
      console.log('[EditorStorage] Stored state expired');
      clearEditorState();
      return null;
    }

    console.log('[EditorStorage] State restored successfully');

    return {
      currentScript: parsed.currentScript,
      currentFilename: parsed.currentFilename,
    };
  } catch (err) {
    console.error('[EditorStorage] Failed to restore state:', err);
    clearEditorState();
    return null;
  }
}

/**
 * Clear stored editor state
 */
export function clearEditorState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    console.log('[EditorStorage] State cleared');
  } catch (err) {
    console.error('[EditorStorage] Failed to clear state:', err);
  }
}

/**
 * Check if there's pending editor state to restore
 * @returns {boolean}
 */
export function hasPendingEditorState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return false;
    
    const parsed = JSON.parse(stored);
    const maxAge = 60 * 60 * 1000;
    
    return Date.now() - parsed.savedAt < maxAge;
  } catch {
    return false;
  }
}

/**
 * Get OAuth return URL with account flag
 * @returns {string}
 */
export function getAccountReturnUrl() {
  return '/?account=true';
}

export default {
  saveEditorState,
  restoreEditorState,
  clearEditorState,
  hasPendingEditorState,
  getAccountReturnUrl,
};
