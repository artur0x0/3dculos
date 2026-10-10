// Undo stack for a contour sketch.
//
// The first observed state is the baseline and is not a step. A later
// change of tool, profile parameters, plane, or loft station pushes that
// baseline. Gesture, picks, and tags are not part of the key, so opening
// Dimension, Arc, or Constraints is not a step. The stack is capped at 64.

const CAP = 64;

export function emptySketchHistory() {
  return { baselineKey: '', baseline: null, stack: [], depth: 0 };
}

function cloneState(state) {
  return globalThis.structuredClone(state);
}

/**
 * Stable key for one undo step. Null when there is no contour state.
 * @param {object|null} state
 * @returns {string|null}
 */
export function sketchEditKey(state) {
  if (!state) return null;
  const loft = state.entry === 'makeLoft' && state.loft
    ? {
      selected: state.loft.selected || 0,
      profiles: (state.loft.profiles || []).map((profile) => ({
        tool: profile.tool,
        params: profile.params,
        offset: profile.offset,
        planeKind: profile.planeKind,
        plane: profile.plane,
      })),
    }
    : null;
  return JSON.stringify({
    tool: state.tool,
    params: state.params,
    planePreset: state.planePreset,
    planeAngles: state.planeAngles,
    planeOffset: state.planeOffset,
    planeBase: state.planeBase,
    loft,
  });
}

/**
 * Record `state`. The first sketch is the baseline. A same key refreshes
 * the baseline without pushing (gesture-only edits). A new key pushes.
 */
export function observeSketchEdit(history, state) {
  const prev = history || emptySketchHistory();
  const key = sketchEditKey(state);
  if (!state || key == null) return emptySketchHistory();
  const snap = cloneState(state);
  if (!prev.baselineKey) {
    return { baselineKey: key, baseline: snap, stack: [], depth: 0 };
  }
  if (key === prev.baselineKey) {
    return { ...prev, baseline: snap };
  }
  const stack = prev.stack.concat(prev.baseline).slice(-CAP);
  return { baselineKey: key, baseline: snap, stack, depth: stack.length };
}

/**
 * Pop one sketch edit. Null when the stack is empty.
 * @returns {{ state: object, history: object }|null}
 */
export function undoSketchEdit(history) {
  const prev = history || emptySketchHistory();
  if (!prev.stack.length) return null;
  const restored = cloneState(prev.stack[prev.stack.length - 1]);
  const stack = prev.stack.slice(0, -1);
  return {
    state: restored,
    history: {
      baselineKey: sketchEditKey(restored) || '',
      baseline: cloneState(restored),
      stack,
      depth: stack.length,
    },
  };
}
