#!/usr/bin/env node
/**
 * G11 Parts vault chrome: Save=Commit label, Branch dropdown (Switch/Create/
 * Delete/Merge), Open browse + assembly choice (Open vs Insert), adapter
 * deleteBranch + branch helpers. Mock only — no network, no tokens.
 */
import { readFileSync } from 'node:fs';
import { createMockGithubAdapter } from '../../src/utils/git/mockGithubAdapter.js';
import { findOrCreateVault } from '../../src/utils/git/vault.js';
import {
  ASSEMBLIES_DIR, assemblyFilePath, assemblyPartPath, sharedPartPath,
} from '../../src/utils/git/vaultLayout.js';
import { stringifySurfJson } from '../../src/utils/git/surfJson.js';
import { fileWrite } from '../../src/utils/git/githubAdapterInterface.js';
import {
  listVaultBrowseItems, planInsertVaultAssemblyParts, openVaultAssembly,
} from '../../src/utils/git/gitWorkspace.js';
import {
  listVaultBranches, createVaultBranch, deleteVaultBranch,
  githubCompareUrl, canDeleteVaultBranch, switchVaultBranch,
} from '../../src/utils/git/gitBranch.js';
import * as gitIndex from '../../src/utils/git/index.js';

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

const BRACKET = assemblyPartPath('Gearbox', 'Bracket');
const BOLT = sharedPartPath('M3 bolt');
const COVER = assemblyPartPath('Cover', 'Lid');
const ASM = assemblyFilePath('Gearbox');
const ASM_COVER = assemblyFilePath('Cover');

async function seedVault() {
  const gh = createMockGithubAdapter({ login: 'artur' });
  const vault = await findOrCreateVault(gh);
  const gearbox = {
    source: 'git', name: 'Gearbox', activeId: BRACKET,
    parts: [
      { id: BRACKET, name: 'Bracket', visible: true, order: 0 },
      { id: BOLT, name: 'M3 bolt', visible: true, order: 1 },
    ],
  };
  const cover = {
    source: 'git', name: 'Cover', activeId: COVER,
    parts: [
      { id: COVER, name: 'Lid', visible: true, order: 0 },
      { id: BOLT, name: 'M3 bolt', visible: true, order: 1 },
    ],
  };
  const seed = await gh.commitFiles(vault.repo, {
    branch: 'main', message: 'seed', baseSha: vault.headSha,
    files: [
      fileWrite(ASM, stringifySurfJson(gearbox)),
      fileWrite(BRACKET, 'return Manifold.cube([10,10,10], true);'),
      fileWrite(BOLT, 'return Manifold.cylinder(6, 1.5, 1.5, 24);'),
      fileWrite(ASM_COVER, stringifySurfJson(cover)),
      fileWrite(COVER, 'return Manifold.cube([20,20,2], true);'),
    ],
  });
  return { gh, repo: vault.repo, seedSha: seed.sha, gearbox };
}

console.log('git G11 — branch helpers (create / delete / compare URL)');
{
  const { gh, repo, seedSha } = await seedVault();
  const created = await createVaultBranch(gh, repo, 'feature/g11', { fromSha: seedSha });
  eq('created branch', created.name, 'feature/g11');
  ok('create from tip', created.sha === seedSha);
  let refuseMain = '';
  try { await deleteVaultBranch(gh, repo, 'main', { current: 'feature/g11' }); }
  catch (err) { refuseMain = err.message; }
  ok('delete main refused', /Cannot delete main/.test(refuseMain), refuseMain);
  let refuseCur = '';
  try { await deleteVaultBranch(gh, repo, 'feature/g11', { current: 'feature/g11' }); }
  catch (err) { refuseCur = err.message; }
  ok('delete current refused', /Cannot delete the current branch/.test(refuseCur), refuseCur);
  ok('canDelete false for main', canDeleteVaultBranch('main', { current: 'feature/g11' }) === false);
  ok('canDelete false for current', canDeleteVaultBranch('feature/g11', { current: 'feature/g11' }) === false);
  ok('canDelete true for other', canDeleteVaultBranch('feature/g11', { current: 'main' }) === true);
  await createVaultBranch(gh, repo, 'tmp', { fromSha: seedSha });
  const del = await deleteVaultBranch(gh, repo, 'tmp', { current: 'main' });
  eq('delete status', del, { status: 'deleted', branch: 'tmp' });
  eq('compare URL', githubCompareUrl({ owner: 'artur', name: 'surfcad' }, { base: 'main', head: 'feature/g11' }),
    'https://github.com/artur/surfcad/compare/main...feature%2Fg11?expand=1');
  ok('compare null without head', githubCompareUrl({ owner: 'a', name: 'b' }, { base: 'main' }) === null);
}

console.log('\ngit G11 — Open browse + insert parts');
{
  const { gh, repo, gearbox } = await seedVault();
  const browse = await listVaultBrowseItems(gh, repo, 'main');
  eq('browse assemblies', browse.assemblies.map((a) => a.name), ['Cover', 'Gearbox']);
  ok('browse has shared bolt', browse.parts.some((p) => p.path === BOLT));
  ok('browse has cover lid', browse.parts.some((p) => p.path === COVER));
  const planned = await planInsertVaultAssemblyParts(gh, repo, 'Cover', gearbox, { branch: 'main' });
  // Shared bolt already in gearbox → skipped; Lid remapped under Gearbox
  const lidAdd = planned.additions.find((a) => a.fromPath === COVER);
  ok('lid remapped into Gearbox', !!lidAdd && lidAdd.id.startsWith(`${ASSEMBLIES_DIR}/Gearbox/parts/`), JSON.stringify(planned.additions));
  ok('shared bolt not re-added', !planned.additions.some((a) => a.id === BOLT));
  eq('insert count', planned.additions.length, 1);
}

console.log('\ngit G11 — UI wiring (PartFeed + App + architecture)');
const feed = readFileSync(new URL('../../src/components/PartFeed.jsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
const arch = readFileSync(new URL('../../docs/architecture.md', import.meta.url), 'utf8');
ok('Save = Commit chrome', /data-git-save=""/.test(feed) && /data-git-commit=""/.test(feed)
  && /aria-label="Save"/.test(feed) && /Save to vault/.test(feed));
ok('Branch dropdown actions', /data-git-branch-dropdown/.test(feed)
  && /data-git-branch-action="switch"/.test(feed)
  && /data-git-branch-action="create"/.test(feed)
  && /data-git-branch-action="delete"/.test(feed)
  && /data-git-branch-action="merge"/.test(feed));
ok('Save before Branch in ribbon end', (() => {
  const end = feed.indexOf('data-parts-ribbon-end');
  const save = feed.indexOf('data-git-save=""', end);
  const branch = feed.indexOf('data-git-branches=""', end);
  return end >= 0 && save > end && branch > save;
})());
ok('Open assembly choice', (/data-git-dialog="open-choice"/.test(feed) || /dataAttr="open-choice"/.test(feed))
  && /data-git-open-replace/.test(feed) && /data-git-open-insert/.test(feed)
  && /Insert parts into current/.test(feed) && /Open assembly/.test(feed));
ok('Open browses parts + assemblies', /data-git-open-assemblies/.test(feed) && /data-git-open-parts/.test(feed)
  && /data-git-open-part=/.test(feed));
ok('delete confirm + protected', /data-git-branch-delete-confirm/.test(feed)
  && /data-git-branch-delete-warn/.test(feed) && /protected/.test(feed));
ok('App wires create/delete/merge/insert/browse', /handleCreateBranch/.test(app)
  && /handleDeleteBranch/.test(app) && /handleMergeBranch/.test(app)
  && /handleInsertVaultAssemblyParts/.test(app) && /handleListVaultBrowse/.test(app)
  && /handleOpenVaultPart/.test(app)
  && /onCreateBranch=\{handleCreateBranch\}/.test(app)
  && /onMergeBranch=\{handleMergeBranch\}/.test(app)
  && /githubCompareUrl\(/.test(app) && /window\.open\(url/.test(app));
ok('index exports G11 helpers', typeof gitIndex.createVaultBranch === 'function'
  && typeof gitIndex.deleteVaultBranch === 'function'
  && typeof gitIndex.githubCompareUrl === 'function'
  && typeof gitIndex.listVaultBrowseItems === 'function'
  && typeof gitIndex.planInsertVaultAssemblyParts === 'function'
  && typeof gitIndex.canDeleteVaultBranch === 'function');
ok('adapter has deleteBranch', typeof gitIndex.createMockGithubAdapter({}).deleteBranch === 'function');
ok('architecture mentions G11 Parts chrome', /G11/.test(arch) && /Save = Commit|Save \(commit\)|Parts vault chrome/i.test(arch));
ok('Toolbar Script is Upload+Download only (G12)', (() => {
  const toolbar = readFileSync(new URL('../../src/components/Toolbar.jsx', import.meta.url), 'utf8');
  return /data-script-upload=""/.test(toolbar) && /data-script-download=""/.test(toolbar)
    && !/title="Open File"/.test(toolbar) && !/onSave/.test(toolbar)
    && !/FolderOpen/.test(toolbar);
})());

console.log(failed ? `\n❌ FAIL (${failed} failed, ${passed} passed)` : `\n✅ PASS (${passed})`);
process.exit(failed ? 1 : 0);
