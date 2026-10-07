#!/usr/bin/env node
/**
 * G13: slim vault create modal (name + Save/Cancel) and conflict popup
 * (Stay on branch / Open on GitHub / Overwrite main) — no toast for that flow.
 */
import { readFileSync } from 'node:fs';

let failed = 0;
let passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const feed = readFileSync(new URL('../../src/components/PartFeed.jsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
const arch = readFileSync(new URL('../../docs/architecture.md', import.meta.url), 'utf8');

console.log('git G13 — slim vault create + conflict popup');

ok('vault create modal title + markers', /Create repo/.test(feed)
  && /data-git-vault-create/.test(feed) && /data-git-vault-name/.test(feed)
  && /data-git-vault-save/.test(feed));
ok('Save + Cancel only (no plan/shared/switch)', /data-git-move-confirm/.test(feed)
  && /data-git-dialog-cancel/.test(feed)
  && !/data-git-move-plan/.test(feed) && !/data-git-move-shared=/.test(feed)
  && !/data-git-move-switch-only/.test(feed) && !/Switch only/.test(feed)
  && !/data-git-move-assembly-path/.test(feed));
ok('seeds without Shared checkboxes', /sharedIds: \[\]/.test(feed));

ok('conflict is a popup not toast', /data-git-conflict-popup/.test(feed)
  && /data-git-force-merge-ask/.test(feed)
  && !/data-git-conflict-toast/.test(feed));
ok('Stay on branch', /data-git-conflict-stay/.test(feed) && /Stay on branch/.test(feed)
  && /data-git-keep-branch/.test(feed) && !/Keep on branch/.test(feed));
ok('Open on GitHub', /data-git-conflict-open-github/.test(feed) && /Open on GitHub/.test(feed)
  && /openConflictOnGithub/.test(feed) && /onMergeBranch\?\.\(\{ head/.test(feed));
ok('Overwrite main keeps force-merge wiring', /data-git-conflict-overwrite/.test(feed)
  && /Overwrite main/.test(feed) && /data-git-force-merge=""/.test(feed)
  && /data-git-force-merge-warning/.test(feed) && /runForceMerge/.test(feed)
  && !/>Force merge</.test(feed));
ok('warning copy preserved via forceMergeWarning', /data-git-conflict-warning/.test(feed)
  && /forceMergeWarning/.test(app));
ok('G4 behind toast unchanged (separate flow)', /data-git-behind-toast/.test(app)
  && /data-git-behind-reload/.test(feed));

ok('light vocab: Repo label, + Part|Assembly New|Existing', /htmlFor="git-move-vault-name"[\s\S]{0,80}Repo/.test(feed)
  && /data-part-add-action="new"/.test(feed)
  && /data-part-add-action="existing"/.test(feed)
  && /data-part-add-section="part"/.test(feed)
  && /data-part-add-section="assembly"/.test(feed)
  && /title="Add part or assembly"/.test(feed));

ok('architecture documents G13', /G13/.test(arch)
  && /Create repo|Create vault|repo create|vault create|slim/i.test(arch)
  && /Stay on branch|Overwrite main|Open on GitHub/.test(arch));

console.log(failed ? `\n❌ FAIL (${failed} failed, ${passed} passed)` : `\n✅ PASS (${passed})`);
process.exit(failed ? 1 : 0);
