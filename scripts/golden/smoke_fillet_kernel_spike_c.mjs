#!/usr/bin/env node
/**
 * Slice C / C2 — fillet kernel recommendation + hard Accept wiring.
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
  shouldUseHardRollingBall,
  hardFilletKernelEffort,
} from '../../src/utils/filletKernelSpike.js';
import { composeFilletCommit } from '../../src/utils/filletMode.js';

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

console.log('fillet kernel spike C / C2');

check('easy kernel id is dihedral sweep', FILLET_KERNEL_EASY === 'sweep-dihedral');
check(
  'hard recommendation is segment rolling-ball',
  FILLET_KERNEL_HARD_RECOMMENDED === 'rolling-ball-segment',
);
check('hard kernel production flag is on (C2)', FILLET_HARD_KERNEL_TRIAL === true);
check('four candidates documented', FILLET_KERNEL_CANDIDATES.length >= 4);

{
  const easy = pickFilletKernelForClass('easy');
  check('easy pick stays sweep', easy.kernel === FILLET_KERNEL_EASY && easy.trial === false);
  const hard = pickFilletKernelForClass('hard');
  check(
    'hard pick names rolling-ball with trial on',
    hard.kernel === FILLET_KERNEL_HARD_RECOMMENDED && hard.trial === true,
  );
  check('shouldUseHardRollingBall true for hard', shouldUseHardRollingBall('hard') === true);
  check('shouldUseHardRollingBall false for easy', shouldUseHardRollingBall('easy') === false);
  const effort = hardFilletKernelEffort();
  check('effort notes C2 done', effort.effort === 'done');
}

{
  const doc = read('../../docs/fillet-kernel-spike-c.md');
  check('spike doc exists', /Recommended|rolling-ball/i.test(doc));
  check('doc keeps easy path', /easy/i.test(doc) && /sweep/i.test(doc));
  check('doc rules out naive sphere-hull', /over-cut|12×|sausage/i.test(doc));
  check('doc notes C2 Accept wired', /C2|Accept wired|relaxPlanar/i.test(doc));
  check('doc notes production flag on', /FILLET_HARD_KERNEL_TRIAL\s*=\s*true/i.test(doc));
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
  check('Accept passes filletClass', /filletClass:\s*edgeClass\.klass/.test(view));
}

{
  const starter = `let part = Manifold.cube([40, 30, 20], true);\nreturn part;`;
  const easyEdge = {
    key: '0-1',
    a: 0,
    b: 1,
    va: [0, 0, 10],
    vb: [40, 0, 10],
    mid: [20, 0, 10],
    length: 40,
    tangent: [1, 0, 0],
    n0: [0, 0, 1],
    n1: [0, -1, 0],
    boundaryId: 4,
    faceA: 2,
    faceB: 5,
    pairCount: 1,
  };
  const easy = composeFilletCommit(starter, {
    edges: [easyEdge],
    params: { strategy: 'sweep', radius: 2 },
    filletClass: 'easy',
  });
  check('easy Accept ok', easy.ok === true, easy.message || '');
  check('easy Accept uses filletAlongPath', /filletAlongPath\s*\(/.test(easy.buffer || ''));
  check('easy Accept kernel is sweep', easy.kernel === 'sweep-dihedral');
  check('easy Accept has no relaxPlanar', !/relaxPlanar/.test(easy.buffer || ''));

  const hardEdge = {
    key: 'h-0',
    a: 10,
    b: 11,
    va: [0, 0, 0],
    vb: [0, 0, 20],
    mid: [0, 0, 10],
    length: 20,
    tangent: [0, 0, 1],
    n0: [1, 0, 0],
    n1: [0, 1, 0],
    // no boundaryId → classifier would also call this hard without mesh
  };
  const hard = composeFilletCommit(starter, {
    edges: [hardEdge],
    params: { strategy: 'sweep', radius: 2, sphericalCorners: true },
    filletClass: 'hard',
  });
  check('hard Accept ok', hard.ok === true, hard.message || '');
  check('hard Accept uses filletEdges', /filletEdges\s*\(/.test(hard.buffer || ''), hard.buffer);
  check('hard Accept sets relaxPlanar', /relaxPlanar:\s*true/.test(hard.buffer || ''), hard.buffer);
  check('hard Accept skips filletAlongPath', !/filletAlongPath\s*\(/.test(hard.buffer || ''));
  check('hard Accept skips makeSweepPath', !/makeSweepPath\s*\(/.test(hard.buffer || ''));
  check('hard Accept kernel is rolling-ball', hard.kernel === 'rolling-ball-segment');
  check('hard Accept keeps edge helpers or coherent literals',
    /edge\s*\(|edgesBetween\s*\(|convexEdges\s*\(|va:\s*\[/.test(hard.buffer || ''), hard.buffer);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll fillet kernel spike C / C2 checks passed.');
