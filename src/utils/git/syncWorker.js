/**
 * Cache-first sync worker.
 *
 * FIFO per repo. Pushes immediately when online. On reconnect: look at the
 * remote commit SHA first. If it differs from lastSyncedSha, do not push and
 * do not overwrite — the caller routes that to the G13 conflict popup.
 * Otherwise push the queue. A `local-` id is promoted in the same commit
 * that first pushes the part.
 */
import { promoteFiles, rewriteSurfIdFields, isSurfJsonPath } from './surfId.js';
import { isAssemblyFile } from './vaultLayout.js';
import { materializeRename, renameFailureToast } from './gitRename.js';
import { repoKeyOf } from './syncStore.js';

async function expandPromotion(adapter, repo, branch, files) {
  const promoted = promoteFiles(files);
  const map = promoted.map;
  const keys = Object.keys(map);
  if (!keys.length || !adapter || !repo) return promoted;
  const tree = await adapter.listTree(repo, branch);
  const have = new Set(promoted.files.map((file) => file.path));
  const extra = [];
  for (const entry of tree || []) {
    const path = entry?.path ?? entry;
    if (!isAssemblyFile(path) && !isSurfJsonPath(path)) continue;
    if (have.has(path)) continue;
    // eslint-disable-next-line no-await-in-loop
    const file = await adapter.readFile(repo, path, branch);
    if (!file?.content || !keys.some((id) => file.content.includes(id))) continue;
    const content = rewriteSurfIdFields(file.content, map);
    if (content !== file.content) extra.push({ path, content });
  }
  return { files: extra.length ? [...promoted.files, ...extra] : promoted.files, map };
}

/**
 * Push queued ops for one repo.
 * -> { status: 'idle'|'offline'|'conflict'|'failed'|'synced', ... }
 * conflict: remote commit SHA !== lastSyncedSha. Nothing was written.
 * failed: the rename (or other) op failed; `toast` is set for renames.
 */
export async function flushSyncQueue({
  store,
  adapter,
  repo,
  branch = 'main',
  online = true,
} = {}) {
  if (!store || !adapter || !repo) return { status: 'idle' };
  await store.ready();
  const key = repoKeyOf(repo);
  const queued = store.pending(key);
  if (!online) return { status: 'offline', pending: queued.length };
  if (!queued.length) return { status: 'idle', sha: store.getLastSyncedSha(key) };

  const remote = (await adapter.getBranch(repo, branch))?.sha || null;
  const synced = store.getLastSyncedSha(key);
  if (synced && remote && remote !== synced) {
    return {
      status: 'conflict',
      remoteSha: remote,
      lastSyncedSha: synced,
      branch,
      baseSha: synced,
      syncHold: true,
      warning: 'The repo moved since the last sync. Nothing was overwritten.',
    };
  }

  let head = remote;
  const promoted = {};
  for (const item of queued) {
    // eslint-disable-next-line no-await-in-loop
    await store.setOpStatus(item.id, 'sending');
    // eslint-disable-next-line no-await-in-loop
    await store.setPartsState(key, item.partIds, 'sending');
    try {
      let files = item.files || [];
      if (item.op === 'rename') {
        // eslint-disable-next-line no-await-in-loop
        const built = await materializeRename(adapter, repo, branch, item.payload);
        files = built.files;
      }
      if (!files.length) {
        // eslint-disable-next-line no-await-in-loop
        await store.setOpStatus(item.id, 'done');
        // eslint-disable-next-line no-await-in-loop
        await store.setPartsState(key, item.partIds, 'clean');
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const prepared = await expandPromotion(adapter, repo, branch, files);
      Object.assign(promoted, prepared.map);
      // eslint-disable-next-line no-await-in-loop
      const res = await adapter.commitFiles(repo, {
        branch,
        message: item.message || 'Sync',
        files: prepared.files,
        baseSha: head,
      });
      head = res.sha;
      // eslint-disable-next-line no-await-in-loop
      await store.setLastSyncedSha(key, head);
      // eslint-disable-next-line no-await-in-loop
      await store.setOpStatus(item.id, 'done');
      // eslint-disable-next-line no-await-in-loop
      await store.setPartsState(key, item.partIds, 'clean');
    } catch (err) {
      // eslint-disable-next-line no-await-in-loop
      await store.setOpStatus(item.id, 'failed', err?.message || 'Sync failed');
      // eslint-disable-next-line no-await-in-loop
      await store.setPartsState(key, item.partIds, 'failed');
      return {
        status: 'failed',
        op: item,
        error: err?.message || 'Sync failed',
        toast: item.op === 'rename' ? renameFailureToast(item, err) : null,
        sha: head,
        promoted,
      };
    }
  }
  return { status: 'synced', sha: head, promoted };
}
