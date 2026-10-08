/**
 * Clear local cache — plan and order, with no network of its own.
 *
 * The wipe is injected (`clearLocalCadData`). This module only decides
 * whether to warn, whether Push first is honest, and whether a flush
 * succeeded before that wipe runs.
 *
 * Push first is the normal git flush. It is offered only when this branch
 * has a queued or sending outbox op. Unsynced parts (`isSynced === false`)
 * that were never queued are not uploaded. A failed, offline, or conflict
 * flush keeps the cache.
 */

const PUSH_OK = new Set(['idle', 'synced']);

function count(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * @param {{ source?: string, hasRepo?: boolean, outboxCount?: number, queuedCount?: number|null, unsyncedCount?: number }} input
 * `outboxCount` is every unpushed outbox row (queued, sending, failed).
 * `queuedCount` is what the normal flush will send (this branch, queued or sending).
 */
export function clearCachePlan({
  source = 'local',
  hasRepo = false,
  outboxCount = 0,
  queuedCount = null,
  unsyncedCount = 0,
} = {}) {
  const outbox = count(outboxCount);
  const queued = queuedCount == null ? outbox : count(queuedCount);
  const unsynced = count(unsyncedCount);
  const git = source === 'git' && !!hasRepo;
  return {
    outbox,
    queued,
    unsynced,
    warn: outbox > 0 || unsynced > 0,
    offerPush: git && queued > 0,
    after: git ? 'repo' : 'local',
  };
}

/**
 * @param {{ pushFirst?: boolean, plan?: object, push: () => Promise<{status?: string}>, wipe: () => Promise<void> }} args
 * Does not call `push` unless the plan offers it. Does not wipe when that push fails.
 */
export async function runClearLocalCache({ pushFirst = false, plan, push, wipe }) {
  if (pushFirst) {
    if (!plan?.offerPush) return { cleared: false, pushed: false, reason: 'no-push' };
    let result;
    try {
      result = await push();
    } catch (error) {
      return { cleared: false, pushed: false, reason: 'push-threw', error };
    }
    if (!PUSH_OK.has(result?.status)) {
      return { cleared: false, pushed: false, result };
    }
  }
  await wipe();
  return { cleared: true, pushed: !!pushFirst, reload: plan?.after || 'local' };
}
