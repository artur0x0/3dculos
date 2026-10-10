import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appCapabilities,
  chooseEdgeLength,
  chooseSolver,
  DESKTOP_REFINE_DOF_CAP,
  detectFeaProfile,
  dofCap,
  frictionDofCap,
  edgeForCap,
  isThinPart,
  partShape,
  PHONE_DOF_CAPS,
  PHONE_FRICTION_DOF_CAPS,
  SHELLS_AVAILABLE,
  THIN_ELEMENTS_THROUGH,
  THIN_WALL_DOF_BUDGET,
  refineDofCap,
  refineMode,
  refinePassLimit,
  wallThickness,
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
  assert.equal(frictionDofCap('phone', false), PHONE_FRICTION_DOF_CAPS.tet10Compact);
  assert.equal(frictionDofCap('phone', true), PHONE_FRICTION_DOF_CAPS.tet10Thin);
  assert.equal(frictionDofCap('desktop', true), Infinity);
  assert.ok(PHONE_FRICTION_DOF_CAPS.tet10Compact * 4 <= PHONE_DOF_CAPS.tet10CompactCholesky);
  assert.ok(PHONE_FRICTION_DOF_CAPS.tet10Thin * 4 <= PHONE_DOF_CAPS.tet10Thin);
});

test('a thin auto edge asks for two through the wall, then keeps a non-sliver edge when the cap cannot', () => {
  const surface = box([80, 2, 40]);
  const shape = partShape(surface.positions, surface.indices);
  assert.equal(isThinPart(shape), true);
  const wall = wallThickness(shape);
  assert.ok(Math.abs(wall - 2) < 0.3, `wall ${wall}`);
  const two = wall / THIN_ELEMENTS_THROUGH;
  const desktop = chooseEdgeLength(shape, 'auto', Infinity);
  const phone = chooseEdgeLength(shape, 'auto', PHONE_DOF_CAPS.tet10Thin);
  assert.ok(desktop.requested <= two * 1.01, `requested ${desktop.requested} vs ${two}`);
  assert.equal(phone.requested, desktop.requested);
  if (desktop.coarsened) {
    assert.ok(desktop.edgeLength > two, 'a coarsened edge is longer than the two-element edge');
    const sliver = desktop.edgeLength > two * 1.05 && desktop.edgeLength < wall * 1.25;
    assert.equal(sliver, false);
  }
  const explicit = chooseEdgeLength(shape, 4, PHONE_DOF_CAPS.tet10Thin);
  assert.equal(explicit.requested, 4);
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

test('refine follows the device unless the study sets it', () => {
  assert.equal(refineMode({ mesh: { refine: 'off' } }, 'desktop'), 'off');
  assert.equal(refineMode({ mesh: { refine: 'auto' } }, 'phone'), 'auto');
  assert.equal(refineMode({ mesh: { target: 'auto' } }, 'desktop'), 'auto');
  assert.equal(refineMode({}, 'phone'), 'off');
  assert.equal(refinePassLimit('phone'), 2);
  assert.equal(refinePassLimit('desktop'), 3);
  assert.equal(refineDofCap('phone', true, 'cholesky'), PHONE_DOF_CAPS.tet10Thin);
  assert.equal(refineDofCap('desktop', true, 'cholesky'), THIN_WALL_DOF_BUDGET);
  assert.equal(refineDofCap('desktop', false, 'pcg'), DESKTOP_REFINE_DOF_CAP);
});

test('capabilities add TET10 and the shell solver', () => {
  assert.equal(SHELLS_AVAILABLE, true);
  assert.equal(PHONE_DOF_CAPS.shell, 90_000);
  const caps = appCapabilities({ solvers: ['stub'], maxDofs: { phone: 1, desktop: 2 } });
  assert.equal(caps.shells, true);
  assert.ok(caps.solvers.includes('tet10'));
  assert.ok(caps.solvers.includes('shell'));
  assert.ok(caps.solvers.includes('stub'));
  assert.equal(caps.maxDofs.phone, 1);
});
