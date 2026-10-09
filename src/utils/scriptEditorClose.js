/**
 * Closing the script editor applies the live buffer through the existing
 * assembly build. It does not schedule a second one.
 *
 * Skip when a build is already in flight for this exact text (the editor's
 * auto-run), when that text was already handed to refreshAssembly, while an
 * assembly open owns the worker, or in the puzzle.
 */
export function shouldRebuildOnEditorClose({
  live,
  lastBuilt = null,
  pendingAutoRun = null,
  assemblyOpenLocked = false,
  game = false,
} = {}) {
  if (game || assemblyOpenLocked) return false;
  if (typeof live !== 'string') return false;
  if (pendingAutoRun === live) return false;
  if (lastBuilt === live) return false;
  return true;
}
