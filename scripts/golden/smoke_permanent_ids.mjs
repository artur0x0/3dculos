#!/usr/bin/env node
/**
 * Permanent surf ids. A mint has no local- prefix. Add to Repo follows
 * isSynced. One migration strips a legacy prefix, keeps the body, and a
 * second pass is a no-op. It never deletes or overwrites a part file.
 * A reload between the commit and the local flag update does not leave
 * Add to Repo stuck.
 */
import { readFileSync } from 'node:fs';
import { createMockGithubAdapter } from '../../src/utils/git/mockGithubAdapter.js';
import { findOrCreateVault } from '../../src/utils/git/vault.js';
import { assemblyFilePath, assemblyPartPath } from '../../src/utils/git/vaultLayout.js';
import { parseSurfJson, stringifySurfJson } from '../../src/utils/git/surfJson.js';
import { fileWrite } from '../../src/utils/git/githubAdapterInterface.js';
import { mintSurfId, withSurfId, readSurfId, stripSurfId, showAddToRepo } from '../../src/utils/git/surfId.js';
import {
  assertMigrationCommitSafe,
  assertPartFilesPreserved,
  migrateAssemblyRecords,
  migrateOutboxOp,
  planSurfIdMigrationCommit,
  reconcileSyncedFromTip,
} from '../../src/utils/git/surfIdMigration.js';
import { createSyncStore } from '../../src/utils/git/syncStore.js';
import { flushSyncQueue } from '../../src/utils/git/syncWorker.js';
import { openVaultAssembly } from '../../src/utils/git/gitWorkspace.js';
import { serializeAssembly } from '../../src/utils/assembly.js';

let failed = 0;
let passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  ok(name, g === w, `got ${g}, want ${w}`);
}
function throws(name, fn, pattern) {
  try {
    fn();
    ok(name, false, 'did not throw');
  } catch (err) {
    ok(name, pattern.test(err?.message || ''), err?.message || '');
  }
}

const WHEN = new Date('2026-10-07T20:56:31.423Z');
const BODY = mintSurfId({ local: true, now: WHEN, rand: 'a3f9' });
const OTHER = mintSurfId({ now: new Date('2026-10-07T20:56:32.100Z'), rand: 'b10c' });
const LOCAL = `local-${BODY}`;
const LOCAL_OTHER = `local-${OTHER}`;
const GROUP = mintSurfId({ now: WHEN, rand: 'ab12' });
const GB = assemblyPartPath('Gearbox', 'Bracket');
const PLATE = assemblyPartPath('Gearbox', 'Plate');
const BRACKET_BODY = 'return Manifold.cube([10,10,10], true);\n';
const PLATE_BODY = 'return Manifold.cube([4,4,1], true);\n';

console.log('mint and Add to Repo');
{
  eq('create emits a bare id', BODY, '2026-10-07-20-56-31-0423-a3f9');
  ok('local option does not prefix', !BODY.startsWith('local-'));
  ok('unsynced offers Add to Repo', showAddToRepo({ id: GB, surfId: BODY, isSynced: false }));
  ok('synced does not', !showAddToRepo({ id: GB, surfId: BODY, isSynced: true }));
  ok('missing flag on a repo path does not', !showAddToRepo({ id: GB, surfId: BODY }));
  ok('local: row id still offers it', showAddToRepo({ id: 'local:abc' }));
  ok('local- row id still offers it', showAddToRepo({ id: 'local-abc' }));
  const doc = serializeAssembly({
    source: 'git',
    name: 'Gearbox',
    activeId: GB,
    parts: [{ id: GB, name: 'Bracket', visible: true, order: 0, surfId: BODY, isSynced: false }],
  });
  ok('assembly document keeps isSynced', doc.parts[0].isSynced === false);
  ok('.surf.json omits isSynced', !stringifySurfJson(doc).includes('isSynced'));
}

console.log('\nmigration strips once and keeps every part file');
{
  const bracket = withSurfId(BRACKET_BODY, LOCAL);
  const plate = withSurfId(PLATE_BODY, OTHER);
  const asm = stringifySurfJson({
    source: 'git',
    name: 'Gearbox',
    activeId: GB,
    parts: [
      { id: GB, name: 'Bracket', visible: true, order: 0, surfId: LOCAL, copiedFrom: LOCAL_OTHER },
      { id: PLATE, name: 'Plate', visible: true, order: 1, surfId: OTHER },
    ],
    groups: [{ id: GROUP, name: 'Cover', source: assemblyFilePath('Cover'), partIds: [LOCAL] }],
  });
  const entries = [
    { path: GB, content: bracket },
    { path: PLATE, content: plate },
    { path: assemblyFilePath('Gearbox'), content: asm },
  ];
  const once = planSurfIdMigrationCommit(entries);
  ok('migration has no deletes', once.files.every((file) => !file.delete));
  ok('untouched part is not rewritten', !once.files.some((file) => file.path === PLATE));
  const after = entries.map((entry) => {
    const hit = once.files.find((file) => file.path === entry.path);
    return hit ? { path: entry.path, content: hit.content } : entry;
  });
  eq('header keeps the body', readSurfId(after.find((entry) => entry.path === GB).content), BODY);
  eq('script body unchanged', stripSurfId(after.find((entry) => entry.path === GB).content), BRACKET_BODY);
  eq('other part bytes unchanged', after.find((entry) => entry.path === PLATE).content, plate);
  const parsed = parseSurfJson(after.find((entry) => entry.path.endsWith('.surf.json')).content);
  eq('json id keeps the body', parsed.parts[0].surfId, BODY);
  eq('copiedFrom keeps the body', parsed.parts[0].copiedFrom, OTHER);
  eq('group partIds keep the body', parsed.groups[0].partIds, [BODY]);
  eq('group id stays', parsed.groups[0].id, GROUP);
  eq('part paths stay', parsed.parts.map((part) => part.id), [GB, PLATE]);
  const twice = planSurfIdMigrationCommit(after);
  ok('second pass is a no-op', twice.changed === false && twice.files.length === 0);
  const again = after.map((entry) => {
    const hit = twice.files.find((file) => file.path === entry.path);
    return hit ? { path: entry.path, content: hit.content } : entry;
  });
  eq('second pass bytes match', again.map((entry) => entry.content), after.map((entry) => entry.content));

  const stray = migrateAssemblyRecords({
    doc: {
      name: 'Gearbox',
      source: 'git',
      parts: [
        { id: 'local-abc', name: 'part1', surfId: LOCAL, copiedFrom: LOCAL_OTHER },
        { id: PLATE, name: 'Plate', surfId: OTHER },
      ],
      groups: [{ id: GROUP, name: 'Cover', source: null, partIds: [LOCAL] }],
    },
    scripts: { [GB]: bracket, [PLATE]: plate },
  });
  eq('row id local-abc is not sliced', stray.doc.parts[0].id, 'local-abc');
  eq('doc surf id keeps the body', stray.doc.parts[0].surfId, BODY);
  eq('doc copiedFrom keeps the body', stray.doc.parts[0].copiedFrom, OTHER);
  eq('doc group partIds keep the body', stray.doc.groups[0].partIds, [BODY]);
  const secondDoc = migrateAssemblyRecords({ doc: stray.doc, scripts: stray.scripts });
  ok('document second pass is a no-op', secondDoc.changed === false && secondDoc.doc === stray.doc);

  const op = {
    op: 'create',
    partIds: [GB],
    files: [fileWrite(GB, bracket), fileWrite(assemblyFilePath('Gearbox'), asm)],
    payload: {
      surfId: LOCAL,
      copiedFrom: LOCAL_OTHER,
      content: bracket,
      assemblyText: asm,
      before: { scripts: { [GB]: bracket } },
    },
  };
  const migratedOp = migrateOutboxOp(op);
  eq('outbox surf id keeps the body', migratedOp.payload.surfId, BODY);
  eq('outbox copiedFrom keeps the body', migratedOp.payload.copiedFrom, OTHER);
  eq('outbox header keeps the body', readSurfId(migratedOp.files[0].content), BODY);
  eq('outbox script body unchanged', stripSurfId(migratedOp.files[0].content), BRACKET_BODY);
  eq('outbox before-script keeps the body', readSurfId(migratedOp.payload.before.scripts[GB]), BODY);
  const opAgain = migrateOutboxOp(migratedOp);
  ok('outbox second pass is a no-op', opAgain === migratedOp);

  throws('lost part file is refused', () => assertPartFilesPreserved(entries, entries.filter((entry) => entry.path !== GB)), /lost part file/);
  throws('overwritten part body is refused', () => assertPartFilesPreserved(
    [{ path: GB, content: bracket }],
    [{ path: GB, content: withSurfId('return 2;\n', BODY) }],
  ), /overwrote part file/);
  throws('a delete is refused', () => assertMigrationCommitSafe([{ path: GB, delete: true }]), /refuses to delete/);
}

console.log('\nheader bytes stay except the id text');
{
  const blank = `// @surf-id ${LOCAL}\n\nconst a = 1;\n`;
  const indented = `// @surf-id ${LOCAL}\n  const a = 1;\n`;
  const crlf = `// @surf-id ${LOCAL}\r\n\r\n  const a = 1;\r\n`;
  const cases = [
    ['blank line', blank, assemblyPartPath('Gearbox', 'Blank')],
    ['indented first line', indented, assemblyPartPath('Gearbox', 'Indent')],
    ['crlf', crlf, assemblyPartPath('Gearbox', 'Crlf')],
  ];
  const entries = cases.map(([, before, path]) => ({ path, content: before }));
  const once = planSurfIdMigrationCommit(entries);
  for (const [label, before, path] of cases) {
    const next = once.files.find((file) => file.path === path)?.content;
    eq(`${label} is the same bytes except the id`, next, before.replace(LOCAL, BODY));
  }
  const after = entries.map((entry) => {
    const hit = once.files.find((file) => file.path === entry.path);
    return hit ? { path: entry.path, content: hit.content } : entry;
  });
  ok('header second pass is a no-op', planSurfIdMigrationCommit(after).changed === false);
}

console.log('\ngroup id is stripped in the repo and in IndexedDB');
{
  const localGroup = `local-${GROUP}`;
  const asm = stringifySurfJson({
    source: 'git',
    name: 'Gearbox',
    activeId: GB,
    parts: [{ id: GB, name: 'Bracket', visible: true, order: 0, surfId: BODY }],
    groups: [{ id: localGroup, name: 'Cover', source: null, partIds: [BODY] }],
  });
  const entries = [
    { path: GB, content: withSurfId(BRACKET_BODY, BODY) },
    { path: assemblyFilePath('Gearbox'), content: asm },
  ];
  const once = planSurfIdMigrationCommit(entries);
  const json = once.files.find((file) => file.path.endsWith('.surf.json'))?.content;
  const parsed = parseSurfJson(json);
  eq('repo group id drops the prefix', parsed.groups[0].id, GROUP);
  const local = migrateAssemblyRecords({
    doc: {
      name: 'Gearbox',
      source: 'git',
      parts: [{ id: GB, name: 'Bracket', surfId: BODY }],
      groups: [{ id: localGroup, name: 'Cover', source: null, partIds: [BODY] }],
    },
    scripts: {},
  });
  eq('indexeddb group id drops the prefix', local.doc.groups[0].id, GROUP);
  eq('repo and indexeddb group ids match', parsed.groups[0].id, local.doc.groups[0].id);
  const again = entries.map((entry) => {
    const hit = once.files.find((file) => file.path === entry.path);
    return hit ? { path: entry.path, content: hit.content } : entry;
  });
  ok('group id second pass is a no-op', planSurfIdMigrationCommit(again).changed === false);
  ok('indexeddb group id second pass is a no-op', migrateAssemblyRecords({ doc: local.doc, scripts: {} }).changed === false);
}

console.log('\nreload between commit and local apply');
{
  const gh = createMockGithubAdapter({ login: 'artur' });
  const vault = await findOrCreateVault(gh);
  const seeded = stringifySurfJson({
    source: 'git', name: 'Gearbox', activeId: GB,
    parts: [{ id: GB, name: 'Bracket', visible: true, order: 0, surfId: OTHER }],
  });
  const seed = await gh.commitFiles(vault.repo, {
    branch: 'main', message: 'seed', baseSha: vault.headSha,
    files: [
      fileWrite(assemblyFilePath('Gearbox'), seeded),
      fileWrite(GB, withSurfId(BRACKET_BODY, OTHER)),
    ],
  });
  const store = createSyncStore({ persist: false });
  await store.setLastSyncedSha(vault.repo, seed.sha);
  const shim = assemblyPartPath('Gearbox', 'Shim');
  const shimBody = 'return Manifold.cube([1,1,1], true);\n';
  const script = withSurfId(shimBody, BODY);
  const doc = {
    source: 'git', name: 'Gearbox', activeId: shim,
    parts: [
      { id: GB, name: 'Bracket', visible: true, order: 0, surfId: OTHER, isSynced: true },
      { id: shim, name: 'Shim', visible: true, order: 1, surfId: BODY, isSynced: false },
    ],
  };
  await store.enqueue(vault.repo, {
    op: 'create',
    message: 'Add Shim',
    partIds: [shim],
    files: [
      fileWrite(shim, script),
      fileWrite(assemblyFilePath('Gearbox'), stringifySurfJson(doc)),
    ],
  });
  const pushed = await flushSyncQueue({ store, adapter: gh, repo: vault.repo, branch: 'main', online: true });
  eq('create synced', pushed.status, 'synced');
  eq('committed header is the minted id', readSurfId((await gh.readFile(vault.repo, shim, 'main')).content), BODY);
  ok('Add to Repo still shows before the local apply', showAddToRepo(doc.parts[1]));
  const opened = await openVaultAssembly(gh, vault.repo, 'Gearbox', { branch: 'main', headSha: pushed.sha });
  const reconciled = reconcileSyncedFromTip(doc, opened.scripts);
  const shimRow = reconciled.doc.parts.find((part) => part.id === shim);
  ok('reload clears isSynced', shimRow.isSynced === true);
  ok('reload does not leave Add to Repo', !showAddToRepo(shimRow));
  eq('reload keeps the id', shimRow.surfId, BODY);
  eq('reload keeps the script body', stripSurfId(opened.scripts[shim]), shimBody);
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  ok('reseed reconciles isSynced from the tip', /reconcileSyncedFromTip\(/.test(app));
}

console.log('\nsync store keys and a delete guard on the worker');
{
  const gh = createMockGithubAdapter({ login: 'artur' });
  const vault = await findOrCreateVault(gh);
  const store = createSyncStore({ persist: false });
  await store.rememberPathId(vault.repo, GB, LOCAL);
  await store.putPart(vault.repo, { surfId: LOCAL, path: GB, content: withSurfId(BRACKET_BODY, LOCAL), previousPath: PLATE });
  await store.enqueue(vault.repo, {
    op: 'save',
    message: 'edit',
    partIds: [GB],
    files: [fileWrite(GB, withSurfId(BRACKET_BODY, LOCAL))],
    payload: { surfId: LOCAL },
  });
  const first = await store.migrateLocalSurfIds();
  ok('store migration changes once', first.changed === true);
  eq('path index keeps the body', store.pathIndexFor(vault.repo)[GB], BODY);
  eq('part row is rekeyed', store.getPartById(vault.repo, BODY)?.surfId, BODY);
  ok('old part key is gone', store.getPartById(vault.repo, LOCAL) == null);
  eq('alias keeps the body', store.getAlias(vault.repo, PLATE), BODY);
  eq('outbox header keeps the body', readSurfId(store.ops()[0].files[0].content), BODY);
  eq('outbox payload keeps the body', store.ops()[0].payload.surfId, BODY);
  const second = await store.migrateLocalSurfIds();
  ok('store second pass is a no-op', second.changed === false);
  const order = createSyncStore({ persist: false });
  await order.enqueue(vault.repo, { op: 'save', message: 'later', partIds: [GB], files: [] });
  await order.enqueue(vault.repo, { op: 'migrate-ids', message: 'Keep part ids', partIds: [], files: [] }, { front: true });
  eq('id migration runs before queued edits', order.pending(vault.repo).map((op) => op.op), ['migrate-ids', 'save']);

  const head = (await gh.commitFiles(vault.repo, {
    branch: 'main', message: 'seed', baseSha: vault.headSha,
    files: [fileWrite(GB, withSurfId(BRACKET_BODY, OTHER))],
  })).sha;
  const guarded = createSyncStore({ persist: false });
  await guarded.setLastSyncedSha(vault.repo, head);
  await guarded.enqueue(vault.repo, {
    op: 'migrate-ids',
    message: 'Keep part ids',
    partIds: [],
    files: [{ path: GB, delete: true }],
  });
  const refused = await flushSyncQueue({ store: guarded, adapter: gh, repo: vault.repo, branch: 'main', online: true });
  eq('delete during migration fails', refused.status, 'failed');
  ok('part file is still in the repo', !!(await gh.readFile(vault.repo, GB, 'main')));
  eq('part bytes were not replaced', (await gh.readFile(vault.repo, GB, 'main')).content, withSurfId(BRACKET_BODY, OTHER));
}

if (failed) {
  console.log(`\npermanent ids: ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\npermanent ids: ${passed} passed`);
