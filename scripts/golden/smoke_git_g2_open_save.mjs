#!/usr/bin/env node
/**
 * G2 open/save in Git mode: list/open .surf.json + parts by path, new part
 * path, add existing from vault, dirty badges, Local|Git toggle.
 * Mock adapter only — no network, no tokens, no commit (G3).
 */
import { readFileSync } from 'node:fs';
import { createMockGithubAdapter } from '../../src/utils/git/mockGithubAdapter.js';
import { findOrCreateVault } from '../../src/utils/git/vault.js';
import {
  assemblyFilePath, assemblyPartPath, sharedPartPath, listAssemblies,
} from '../../src/utils/git/vaultLayout.js';
import { stringifySurfJson, parseSurfJson } from '../../src/utils/git/surfJson.js';
import { fileWrite } from '../../src/utils/git/githubAdapterInterface.js';
import {
  dirtyPartIds, isAssemblyDirty, isPartDirty, isWorkspaceDirty,
  listVaultAssemblies, listAddableVaultParts, openVaultAssembly, readVaultPart,
  resolveNewPartPath, suggestNewPartPath,
} from '../../src/utils/git/gitWorkspace.js';
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

console.log('git G2 — seed vault with two assemblies');
const gh = createMockGithubAdapter({ login: 'artur' });
const vault = await findOrCreateVault(gh);
eq('vault ready', [vault.status, vault.repo.name], ['created', 'surfcad']);
const gearbox = {
  source: 'git',
  name: 'Gearbox',
  activeId: assemblyPartPath('Gearbox', 'Bracket'),
  parts: [
    { id: assemblyPartPath('Gearbox', 'Bracket'), name: 'Bracket', visible: true, order: 0 },
    { id: sharedPartPath('M3 bolt'), name: 'M3 bolt', visible: true, order: 1 },
  ],
};
const cover = {
  source: 'git',
  name: 'Cover',
  activeId: assemblyPartPath('Cover', 'Lid'),
  parts: [
    { id: assemblyPartPath('Cover', 'Lid'), name: 'Lid', visible: true, order: 0 },
  ],
};
const seed = await gh.commitFiles(vault.repo, {
  branch: 'main',
  message: 'assemblies',
  baseSha: vault.headSha,
  files: [
    fileWrite(assemblyFilePath('Gearbox'), stringifySurfJson(gearbox)),
    fileWrite(assemblyPartPath('Gearbox', 'Bracket'), 'return Manifold.cube([10,10,10], true);'),
    fileWrite(sharedPartPath('M3 bolt'), 'return Manifold.cylinder(6, 1.5, 1.5, 24);'),
    fileWrite(assemblyFilePath('Cover'), stringifySurfJson(cover)),
    fileWrite(assemblyPartPath('Cover', 'Lid'), 'return Manifold.cube([20,20,2], true);'),
    fileWrite(assemblyPartPath('Gearbox', 'Spare'), 'return Manifold.cube([1,1,1], true);'),
  ],
});
eq('list assemblies', await listVaultAssemblies(gh, vault.repo, 'main'), ['Cover', 'Gearbox']);
eq('listAssemblies on tree', listAssemblies(await gh.listTree(vault.repo, 'main')), ['Cover', 'Gearbox']);

console.log('\ngit G2 — open loads parts by path');
const opened = await openVaultAssembly(gh, vault.repo, 'Gearbox', {
  branch: 'main', headSha: seed.sha,
});
eq('opened name', opened.doc.name, 'Gearbox');
eq('opened source', opened.doc.source, 'git');
eq('opened part ids', opened.doc.parts.map((p) => p.id), [
  assemblyPartPath('Gearbox', 'Bracket'),
  sharedPartPath('M3 bolt'),
]);
eq('bracket script', opened.scripts[assemblyPartPath('Gearbox', 'Bracket')],
  'return Manifold.cube([10,10,10], true);');
eq('shared bolt script', opened.scripts[sharedPartPath('M3 bolt')],
  'return Manifold.cylinder(6, 1.5, 1.5, 24);');
eq('baseline assembly path', opened.baseline.assemblyPath, assemblyFilePath('Gearbox'));
ok('baseline has both scripts',
  opened.baseline.scripts[assemblyPartPath('Gearbox', 'Bracket')]?.includes('cube')
  && opened.baseline.scripts[sharedPartPath('M3 bolt')]?.includes('cylinder'));
ok('round-trip surf', parseSurfJson(opened.baseline.assemblyText).name === 'Gearbox');

console.log('\ngit G2 — dirty tracking');
const base = opened.baseline;
ok('clean after open', !isWorkspaceDirty(opened.doc, opened.scripts, base));
ok('assembly clean', !isAssemblyDirty(opened.doc, base));
ok('part clean', !isPartDirty(assemblyPartPath('Gearbox', 'Bracket'),
  opened.scripts[assemblyPartPath('Gearbox', 'Bracket')], base));
const edited = { ...opened.scripts, [assemblyPartPath('Gearbox', 'Bracket')]: 'return Manifold.cube([11,11,11], true);' };
ok('script edit is dirty', isPartDirty(assemblyPartPath('Gearbox', 'Bracket'),
  edited[assemblyPartPath('Gearbox', 'Bracket')], base));
ok('workspace dirty after edit', isWorkspaceDirty(opened.doc, edited, base));
eq('dirtyPartIds after edit', [...dirtyPartIds(opened.doc, edited, base)],
  [assemblyPartPath('Gearbox', 'Bracket')]);
const renamed = {
  ...opened.doc,
  parts: opened.doc.parts.map((p, i) => (i === 0 ? { ...p, name: 'Arm' } : p)),
};
ok('rename dirties assembly', isAssemblyDirty(renamed, base) && isWorkspaceDirty(renamed, opened.scripts, base));
const withNew = {
  ...opened.doc,
  parts: [...opened.doc.parts, {
    id: assemblyPartPath('Gearbox', 'Part 2'), name: 'Part 2', visible: true, order: 2,
  }],
};
const scriptsNew = { ...opened.scripts, [assemblyPartPath('Gearbox', 'Part 2')]: '// new' };
eq('new part id is dirty', [...dirtyPartIds(withNew, scriptsNew, base)].sort(),
  [assemblyPartPath('Gearbox', 'Part 2')].sort());
const withoutBolt = {
  ...opened.doc,
  parts: opened.doc.parts.filter((p) => p.id !== sharedPartPath('M3 bolt')),
  activeId: assemblyPartPath('Gearbox', 'Bracket'),
};
ok('removed part counted dirty', dirtyPartIds(withoutBolt, opened.scripts, base).has(sharedPartPath('M3 bolt')));
ok('no baseline → not dirty', !isWorkspaceDirty(opened.doc, edited, null));
ok('liveScript overrides stored', dirtyPartIds(opened.doc, opened.scripts, base, {
  liveId: assemblyPartPath('Gearbox', 'Bracket'),
  liveScript: 'CHANGED',
}).has(assemblyPartPath('Gearbox', 'Bracket')));

console.log('\ngit G2 — new part path');
eq('bare name → assembly part', resolveNewPartPath('Gearbox', 'Bracket'),
  assemblyPartPath('Gearbox', 'Bracket'));
eq('full assembly path', resolveNewPartPath('Gearbox', assemblyPartPath('Gearbox', 'X')),
  assemblyPartPath('Gearbox', 'X'));
eq('shared path allowed', resolveNewPartPath('Gearbox', 'parts/Pin.js'), sharedPartPath('Pin'));
eq('other assembly refused', resolveNewPartPath('Gearbox', 'assemblies/Cover/parts/Lid.js'), null);
eq('suggest skips existing', suggestNewPartPath('Gearbox', opened.doc.parts),
  assemblyPartPath('Gearbox', 'Part 1'));
ok('index exports G2', typeof gitIndex.openVaultAssembly === 'function'
  && typeof gitIndex.isWorkspaceDirty === 'function'
  && typeof gitIndex.suggestNewPartPath === 'function');

console.log('\ngit G2 — add existing from vault');
const addable = await listAddableVaultParts(gh, vault.repo, 'Gearbox', {
  branch: 'main',
  existingIds: opened.doc.parts.map((p) => p.id),
});
eq('addable includes Spare only (not Bracket/bolt)', addable.map((a) => a.path), [
  assemblyPartPath('Gearbox', 'Spare'),
]);
eq('Spare kind', addable[0].kind, 'assembly-part');
const spare = await readVaultPart(gh, vault.repo, assemblyPartPath('Gearbox', 'Spare'), 'main');
eq('read spare', spare?.content, 'return Manifold.cube([1,1,1], true);');
const addableCover = await listAddableVaultParts(gh, vault.repo, 'Cover', {
  existingIds: [],
});
ok('Cover can add shared bolt', addableCover.some((a) => a.path === sharedPartPath('M3 bolt')));
ok('Cover cannot add Gearbox Spare', !addableCover.some((a) => a.path === assemblyPartPath('Gearbox', 'Spare')));

console.log('\ngit G2 — UI wiring (PartFeed + App)');
const feed = readFileSync(new URL('../../src/components/PartFeed.jsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
ok('Local|Git is a toggle', /data-parts-source-toggle/.test(feed)
  && /source === 'git' \? 'Git' : 'Local'/.test(feed)
  && /onToggleSource/.test(feed));
ok('toggle dirty badge', /data-git-dirty-badge/.test(feed) && /data-git-dirty=/.test(feed));
ok('row dirty badge', /data-part-dirty/.test(feed) && /row\.dirty/.test(feed));
ok('git Open lists vault', /data-git-open-list/.test(feed) && /onListVaultAssemblies/.test(feed)
  && /onOpenVaultAssembly/.test(feed));
ok('new part asks for path', /data-git-new-part-path/.test(feed) && /New part path/.test(feed));
ok('add existing picker', /data-git-add-existing/.test(feed) && /data-git-add-list/.test(feed)
  && /onAddExistingPart/.test(feed));
ok('Connect still git-only (G7 gates on client id)',
  /data-git-connect=""/.test(feed) && /source === 'git'/.test(feed)
  && /githubConnectReady/.test(feed));
ok('App wires vault open + dirty',
  /handleOpenVaultAssembly/.test(app)
  && /handleToggleSource/.test(app)
  && /isWorkspaceDirty/.test(app)
  && /dirtyPartIds/.test(app)
  && /sourceDirty=\{!!sourceDirty\}/.test(app)
  && /createMockGithubAdapter/.test(app)
  && /findOrCreateVault/.test(app));
ok('App new part resolveNewPartPath in git',
  /resolveNewPartPath\(doc\.name, gitPath\)/.test(app));
ok('Find in repo uses vault', /handleFindInRepo/.test(app) && /onFindInRepo/.test(feed));
const srcFiles = ['gitWorkspace', 'githubAdapterInterface', 'mockGithubAdapter', 'vaultLayout', 'surfJson', 'vault']
  .map((f) => readFileSync(new URL(`../../src/utils/git/${f}.js`, import.meta.url), 'utf8')).join('\n');
ok('no network or token use in G2', !/\bfetch\(|api\.github\.com|XMLHttpRequest|Authorization:\s*['"]Bearer/.test(srcFiles));
ok('G2 does not commit from workspace helpers',
  !/commitFiles/.test(readFileSync(new URL('../../src/utils/git/gitWorkspace.js', import.meta.url), 'utf8')));

console.log(failed ? `\n❌ FAIL (${failed} failed, ${passed} passed)` : `\n✅ PASS (${passed})`);
process.exit(failed ? 1 : 0);
