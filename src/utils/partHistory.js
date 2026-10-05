/**
 * Undo stack for one part.
 *
 * The editor has one Monaco buffer, but each part keeps its own commits.
 * Switching parts swaps stacks. A commit is never copied onto another part.
 */

export function emptyPartHistory() {
  return { commits: [], head: -1 };
}

/**
 * The stack already stored for this part, or one seed commit of its script.
 * A seed head is 0, so Undo stays disabled until this part is edited.
 */
export function historyForPart(histories, partId, script) {
  const key = partId == null ? '' : String(partId);
  const existing = histories && histories[key];
  if (existing && Array.isArray(existing.commits) && existing.commits.length) {
    return existing;
  }
  const code = typeof script === 'string' ? script : '';
  return {
    commits: [{ code, message: 'Part', timestamp: 0, id: `seed:${key}` }],
    head: 0,
  };
}

/** Append a commit. The same code as the current head is not a new step. */
export function pushPartHistory(history, code, message) {
  const base = history && Array.isArray(history.commits) ? history : emptyPartHistory();
  const head = Number.isInteger(base.head) ? base.head : -1;
  const top = head >= 0 ? base.commits[head] : null;
  if (top && top.code === code) return { commits: base.commits, head };
  const commits = base.commits.slice(0, Math.max(0, head + 1));
  commits.push({
    code,
    message: message || 'Code updated',
    timestamp: Date.now(),
    id: `${Date.now()}-${commits.length}`,
  });
  return { commits, head: commits.length - 1 };
}

/** Step back on this part only. `code` is null when there is nothing to undo. */
export function undoPartHistory(history) {
  if (!history || !(history.head > 0) || !Array.isArray(history.commits)) {
    return { history: history || emptyPartHistory(), code: null };
  }
  const head = history.head - 1;
  const code = history.commits[head]?.code;
  if (typeof code !== 'string') return { history, code: null };
  return { history: { commits: history.commits, head }, code };
}

/** Step forward on this part only. `code` is null when there is nothing to redo. */
export function redoPartHistory(history) {
  if (!history || !Array.isArray(history.commits)) {
    return { history: history || emptyPartHistory(), code: null };
  }
  if (history.head >= history.commits.length - 1) return { history, code: null };
  const head = history.head + 1;
  const code = history.commits[head]?.code;
  if (typeof code !== 'string') return { history, code: null };
  return { history: { commits: history.commits, head }, code };
}
