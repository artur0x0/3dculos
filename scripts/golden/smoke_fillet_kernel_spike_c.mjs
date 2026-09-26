#!/usr/bin/env node
/**
 * Slice C — fillet kernel spike recommendation helpers + chrome nits.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FILLET_KERNEL_EASY,
  FILLET_KERNEL_HARD_RECOMMENDED,
  FILLET_HARD_KERNEL_TRIAL,
  FILLET_KERNEL_CANDIDATES,
  pickFilletKernelForClass,
  hardFilletKernelEffort,
} from '../../src/utils/filletKernelSpike.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('fillet kernel spike C');

check('easy kernel id is dihedral sweep', FILLET_KERNEL_EASY === 'sweep-dihedral');
check(
  'hard recommendation is segment rolling-ball',
  FILLET_KERNEL_HARD_RECOMMENDED === 'rolling-ball-segment',
);
check('hard trial flag is off in Slice C', FILLET_HARD_KERNEL_TRIAL === false);
check('four candidates documented', FILLET_KERNEL_CANDIDATES.length >= 4);

{
  const easy = pickFilletKernelForClass('easy');
  check('easy pick stays sweep', easy.kernel === FILLET_KERNEL_EASY && easy.trial === false);
  const hard = pickFilletKernelForClass('hard');
  check(
    'hard pick names rolling-ball without enabling trial',
    hard.kernel === FILLET_KERNEL_HARD_RECOMMENDED && hard.trial === false,
  );
  const effort = hardFilletKernelEffort();
  check('effort is one follow-up PR', effort.effort === '1-follow-up-PR');
}

{
  const doc = read('../../docs/fillet-kernel-spike-c.md');
  check('spike doc exists', /Recommended|rolling-ball/i.test(doc));
  check('doc keeps easy path', /easy/i.test(doc) && /sweep/i.test(doc));
  check('doc rules out naive sphere-hull', /over-cut|12×|sausage/i.test(doc));
}

{
  const view = read('../../src/components/Viewport.jsx');
  const panel = read('../../src/components/CrossSectionPanel.jsx');
  check('prior pick mode ref exists', /filletPriorPickModeRef/.test(view));
  check(
    'Accept no longer snaps to Face',
    !/if \(ok\) \{\s*edgeRematchToastSuppressRef[\s\S]{0,120}setPickMode\('face'\)/.test(view),
  );
  check(
    'selector gap on pick mode',
    /flex gap-1[\s\S]{0,240}data-selector-group="pick-mode"/.test(panel)
      && /flex gap-1[\s\S]{0,240}data-selector-group="plane-contour"/.test(panel),
  );
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll fillet kernel spike C checks passed.');
