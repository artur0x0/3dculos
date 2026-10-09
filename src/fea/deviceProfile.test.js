import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appCapabilities,
  chooseSolver,
  detectFeaProfile,
  dofCap,
  edgeForCap,
  isThinPart,
  partShape,
  PHONE_DOF_CAPS,
  SHELLS_AVAILABLE,
} from './deviceProfile.js';
import { box } from './meshShapes.js';

test('a flat beam is thin and uses Cholesky', () => {
  const surface = box([40, 10, 10]);
  const shape = partShape(surface.positions, surface.indices);
  assert.equal(isThinPart(shape), true);
  assert.equal(chooseSolver(shape), 'cholesky');
  assert.equal(dofCap('phone', true, 'cholesky'), PHONE_DOF_CAPS.tet10Thin);
  assert.equal(dofCap('desktop', true, 'cholesky'), Infinity);
});

test('a cube is compact and uses PCG', () => {
  const surface = box([20, 20, 20]);
  const shape = partShape(surface.positions, surface.indices);
  assert.equal(isThinPart(shape), false);
  assert.equal(chooseSolver(shape), 'pcg');
  assert.equal(dofCap('phone', false, 'pcg'), PHONE_DOF_CAPS.tet10CompactPcg);
  assert.equal(dofCap('phone', false, 'cholesky'), PHONE_DOF_CAPS.tet10CompactCholesky);
});

test('the DOF cap lengthens an edge that would pass it', () => {
  const volume = 8000;
  const fine = edgeForCap(volume, 0.2, 100_000);
  assert.equal(fine.coarsened, true);
  assert.ok(fine.edgeLength > 0.2);
  const coarse = edgeForCap(volume, 4, 100_000);
  assert.equal(coarse.coarsened, false);
  assert.equal(coarse.edgeLength, 4);
  assert.equal(edgeForCap(volume, 4, Infinity).coarsened, false);
});

test('phone is touch plus a small screen or a small deviceMemory', () => {
  const phone = detectFeaProfile({
    navigator: { maxTouchPoints: 1, deviceMemory: 8 },
    window: { innerWidth: 390, screen: { width: 390, height: 844 } },
  });
  assert.equal(phone, 'phone');
  const lowMemory = detectFeaProfile({
    navigator: { maxTouchPoints: 2, deviceMemory: 4 },
    window: { innerWidth: 1400, screen: { width: 1400, height: 900 } },
  });
  assert.equal(lowMemory, 'phone');
  const desktopTouch = detectFeaProfile({
    navigator: { maxTouchPoints: 1, deviceMemory: 8 },
    window: { innerWidth: 1280, screen: { width: 1280, height: 800 } },
  });
  assert.equal(desktopTouch, 'desktop');
  const mouse = detectFeaProfile({
    navigator: { maxTouchPoints: 0, deviceMemory: 2 },
    window: { innerWidth: 390, screen: { width: 390, height: 844 } },
  });
  assert.equal(mouse, 'desktop');
});

test('capabilities add TET10 and leave shells off', () => {
  assert.equal(SHELLS_AVAILABLE, false);
  const caps = appCapabilities({ solvers: ['stub'], maxDofs: { phone: 1, desktop: 2 } });
  assert.equal(caps.shells, false);
  assert.ok(caps.solvers.includes('tet10'));
  assert.ok(caps.solvers.includes('stub'));
  assert.equal(caps.maxDofs.phone, 1);
});
