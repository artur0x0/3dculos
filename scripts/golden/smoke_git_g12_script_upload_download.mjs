#!/usr/bin/env node
/**
 * G12 Script strip: model Upload + Download only. File Open/Save and vault
 * chrome live on Parts (G11). Editor actions (Run, Select all, Undo/Redo,
 * Quote) stay on the Script strip. The puzzle is not a strip button.
 */
import { readFileSync } from 'node:fs';

let failed = 0;
let passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const toolbar = readFileSync(new URL('../../src/components/Toolbar.jsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
const view = readFileSync(new URL('../../src/components/Viewport.jsx', import.meta.url), 'utf8');
const feed = readFileSync(new URL('../../src/components/PartFeed.jsx', import.meta.url), 'utf8');
const arch = readFileSync(new URL('../../docs/architecture.md', import.meta.url), 'utf8');

console.log('git G12 — Script Upload + Download only');

ok('Upload + Download markers', /data-script-upload=""/.test(toolbar) && /data-script-download=""/.test(toolbar));
ok('no file Open on Script', !/title="Open File"/.test(toolbar) && !/FolderOpen/.test(toolbar)
  && !/accept="\.js,\.txt"/.test(toolbar) && !/handleFileSelect/.test(toolbar));
ok('no file Save on Script', !/\bonSave\b/.test(toolbar) && !/\bSave\b/.test(toolbar.split('from \'lucide-react\'')[0])
  && !/Save As/.test(toolbar));
ok('no vault chrome on Script Toolbar', !/data-git-commit/.test(toolbar) && !/data-git-branches/.test(toolbar)
  && !/data-git-save/.test(toolbar) && !/Move to Git/.test(toolbar) && !/GitBranch/.test(toolbar));
ok('model accept types kept', /accept="\.stl,\.obj,\.3mf,\.step,\.stp"/.test(toolbar));
ok('editor actions remain', /data-cad-run/.test(toolbar) && /data-cad-select-all/.test(toolbar)
  && /title="Undo"/.test(toolbar) && /title="Redo"/.test(toolbar)
  && /Get Quote/.test(toolbar) && !/Play match-the-part puzzle/.test(toolbar)
  && !/onStartGame/.test(toolbar));

ok('App dropped script file Open/Save handlers', !/const handleOpen = async/.test(app)
  && !/const handleSave = /.test(app) && !/onOpen=\{handleOpen\}/.test(app)
  && !/onSave=\{handleSave\}/.test(app) && !/file-saver/.test(app));
ok('Viewport Toolbar no longer gets onOpen/onSave',
  !/createPortal\([\s\S]*?<Toolbar[\s\S]*?onOpen=\{onOpen\}/.test(view)
  && !/<Toolbar[\s\S]{0,400}onSave=\{onSave\}/.test(view));

ok('Parts chrome untouched (Save/title-branch/Open)', /data-git-save=""/.test(feed)
  && /data-git-commit=""/.test(feed) && /data-git-branches=""/.test(feed)
  && /data-assembly-branch=""/.test(feed) && /data-git-branch-pane=""/.test(feed)
  && /data-assembly-load=""/.test(feed) && !/data-git-branch-dropdown/.test(feed));

ok('architecture notes G12 Script role', /G12/.test(arch)
  && /Upload \+ Download|Upload and Download|Upload\/Download/.test(arch));

console.log(failed ? `\n❌ FAIL (${failed} failed, ${passed} passed)` : `\n✅ PASS (${passed})`);
process.exit(failed ? 1 : 0);
