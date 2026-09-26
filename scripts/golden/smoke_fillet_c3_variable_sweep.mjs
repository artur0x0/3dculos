#!/usr/bin/env node
/**
 * Slice C3 — tangency field + Tangent-on loft + variable-profile hard sweep.
 *
 * Asserts:
 * - shared tangency field distinguishes true G1 from tessellation zig-zag
 * - loft Tangent-on selects a human-scale chain (not 0, not ~160)
 * - hard Accept emits makeSweepPath + filletAlongPath({ variableProfile })
 * - hard loft Accept at R≈1.6 stays manifold-ish; scrap delta vs baseline is modest
 * - easy cube Accept still uses plain filletAlongPath (no variableProfile)
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BufferGeometry, BufferAttribute } from 'three';
import {
  buildFeatureEdges,
  buildCoherentEdges,
  toggleEdgeSelectionPropagated,
  COHERENT_EDGE_MAX,
} from '../../src/utils/selectEdge.js';
import {
  annotateFeatureEdges,
  indexBoundaryEdges,
} from '../../src/utils/boundaryEdgeIds.js';
import {
  isTrueG1,
  propagateTrueTangentEdges,
  densifyPathPoints,
  buildInscribedArcFrame,
  TANGENCY_CHAIN_MAX,
} from '../../src/utils/edgeTangencyField.js';
import { classifyFilletEdges, countDegenerateTriangles } from '../../src/utils/filletEdgeClass.js';
import { composeFilletCommit } from '../../src/utils/filletMode.js';
import { isFilletSliverDirty } from '../../src/utils/filletSliverGuard.js';
import {
  FILLET_HARD_KERNEL_TRIAL,
  FILLET_KERNEL_HARD_RECOMMENDED,
  shouldUseHardVariableSweep,
} from '../../src/utils/filletKernelSpike.js';

const __here = dirname(fileURLToPath(import.meta.url));
const readRepo = (rel) => readFileSync(join(__here, '../..', rel), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('fillet C3 variable-profile + tangency field');

check('hard kernel is variable-profile-sweep', FILLET_KERNEL_HARD_RECOMMENDED === 'variable-profile-sweep');
check('hard production flag on', FILLET_HARD_KERNEL_TRIAL === true);
check('shouldUseHardVariableSweep(hard)', shouldUseHardVariableSweep('hard') === true);
check('shouldUseHardVariableSweep(easy)', shouldUseHardVariableSweep('easy') === false);
check('tangency cap matches coherent cap', TANGENCY_CHAIN_MAX === COHERENT_EDGE_MAX);

{
  const workerSrc = readRepo('src/workers/sandboxWorker.js');
  check(
    'sandboxWorker call-site buildVariableProfileFrames',
    /\bbuildVariableProfileFrames\s*\(/.test(workerSrc),
  );
  check(
    'sandboxWorker densify gated by variableProfile',
    /if\s*\(\s*variableProfile\s*&&\s*!opts\._rawPath\s*\)/.test(workerSrc)
      && /densifyPathPoints\s*\(/.test(workerSrc),
  );
  check(
    'sandboxWorker hard path calls _s23BuildVariableProfileCutter',
    /variableProfile[\s\S]{0,120}_s23BuildVariableProfileCutter\s*\(/.test(workerSrc),
  );
  check(
    'sandboxWorker densified probe gate (0.85 / 0.55*segL)',
    /bestD\s*<=\s*Math\.max\(\s*0\.85\s*,\s*Math\.max\(\s*0\.55\s*\*\s*\(segL/.test(workerSrc),
  );
  const viewSrc = readRepo('src/components/Viewport.jsx');
  check(
    'Viewport scrap banner uses delta threshold',
    /introduced\s*>\s*Math\.max\(\s*300\s*,\s*0\.1\s*\*\s*Math\.max\(\s*preDeg/.test(viewSrc),
  );
}

{
  // True G1 vs zig-zag: same tangent, flipped walls → reject.
  const a = {
    key: 'a', a: 0, b: 1,
    va: [0, 0, 0], vb: [0, 0, 1], mid: [0, 0, 0.5],
    length: 1, tangent: [0, 0, 1],
    n0: [1, 0, 0], n1: [0, 1, 0],
  };
  const g1 = {
    key: 'g1', a: 1, b: 2,
    va: [0, 0, 1], vb: [0, 0, 2], mid: [0, 0, 1.5],
    length: 1, tangent: [0, 0, 1],
    n0: [1, 0, 0], n1: [0, 1, 0],
  };
  const zig = {
    key: 'z', a: 1, b: 3,
    va: [0, 0, 1], vb: [0, 0, 2], mid: [0, 0, 1.5],
    length: 1, tangent: [0, 0, 1],
    n0: [-1, 0, 0], n1: [0, -1, 0],
  };
  check('true G1 accepts continuous walls', isTrueG1(a, g1) === true);
  check('true G1 rejects flipped-wall zig-zag', isTrueG1(a, zig) === false);
  const chain = propagateTrueTangentEdges([a, g1, zig], a);
  check('propagate keeps true chain only', chain.length === 2, `n=${chain.length}`);

  const dense = densifyPathPoints([[0, 0, 0], [0, 0, 10]], false, 2);
  check('densify inserts knots', dense.length >= 6, `n=${dense.length}`);
  const fr = buildInscribedArcFrame([0, 0, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0], 1.6);
  check('inscribed-arc frame has squareSide≈2R', fr && Math.abs(fr.squareSide - 3.2) < 1e-9, fr?.squareSide);
  check('inscribed-arc frame theta is 90°', fr && Math.abs(fr.theta - Math.PI / 2) < 1e-6);
}

{
  const starter = 'let part = Manifold.cube([40, 30, 20], true);\nreturn part;';
  const tagged = {
    key: '0-1', a: 0, b: 1,
    va: [0, 0, 10], vb: [40, 0, 10], mid: [20, 0, 10],
    length: 40, tangent: [1, 0, 0],
    n0: [0, 0, 1], n1: [0, -1, 0],
    boundaryId: 4, faceA: 2, faceB: 5, pairCount: 1,
  };
  const easy = composeFilletCommit(starter, {
    edges: [tagged],
    params: { strategy: 'sweep', radius: 2 },
    filletClass: 'easy',
  });
  check('easy compose stays sweep', easy.ok && /filletAlongPath\s*\(/.test(easy.buffer));
  check('easy compose has no variableProfile', !/variableProfile/.test(easy.buffer || ''));
  check('easy kernel sweep-dihedral', easy.kernel === 'sweep-dihedral');

  const hardEdge = {
    key: 'h-0', a: 10, b: 11,
    va: [0, 0, 0], vb: [0, 0, 20], mid: [0, 0, 10],
    length: 20, tangent: [0, 0, 1],
    n0: [1, 0, 0], n1: [0, 1, 0],
  };
  const hard = composeFilletCommit(starter, {
    edges: [hardEdge],
    params: { strategy: 'sweep', radius: 1.6, sphericalCorners: true },
    filletClass: 'hard',
  });
  check('hard compose ok', hard.ok === true, hard.message || '');
  check('hard emits filletAlongPath', /filletAlongPath\s*\(/.test(hard.buffer || ''));
  check('hard emits variableProfile', /variableProfile:\s*true/.test(hard.buffer || ''), hard.buffer?.slice(-300));
  check('hard emits makeSweepPath', /makeSweepPath\s*\(/.test(hard.buffer || ''));
  check('hard skips relaxPlanar', !/relaxPlanar/.test(hard.buffer || ''));
  check('hard kernel variable-profile-sweep', hard.kernel === 'variable-profile-sweep');
}

register('./manifold-resolve-hook.mjs', import.meta.url);

const pending = new Map();
let msgId = 0;
const workerSelf = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'loaded') return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.type === 'error') waiter.reject(new Error(msg.payload?.message || 'worker error'));
    else waiter.resolve(msg);
  },
};
globalThis.self = workerSelf;
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    Promise.resolve().then(() => {
      workerSelf.onmessage({ data: { type, payload, id } });
    });
  });
}
await import('../../src/workers/sandboxWorker.js');
await send('init');
async function exec(script) {
  const res = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
  return res.payload;
}
function geomOf(mesh) {
  const g = new BufferGeometry();
  const np = mesh.numProp || 3;
  const pos = new Float32Array(mesh.vertProperties.length / np * 3);
  for (let i = 0, j = 0; i < mesh.vertProperties.length; i += np, j += 3) {
    pos[j] = mesh.vertProperties[i];
    pos[j + 1] = mesh.vertProperties[i + 1];
    pos[j + 2] = mesh.vertProperties[i + 2];
  }
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(new BufferAttribute(new Uint32Array(mesh.triVerts), 1));
  return g;
}
function sliverCount(mesh) {
  const np = mesh.numProp || 3;
  const V = mesh.vertProperties;
  const T = mesh.triVerts;
  const nTri = T.length / 3;
  let tiny = 0;
  for (let ti = 0; ti < nTri; ti++) {
    const i0 = T[ti * 3] * np;
    const i1 = T[ti * 3 + 1] * np;
    const i2 = T[ti * 3 + 2] * np;
    const ax = V[i1] - V[i0], ay = V[i1 + 1] - V[i0 + 1], az = V[i1 + 2] - V[i0 + 2];
    const bx = V[i2] - V[i0], by = V[i2 + 1] - V[i0 + 1], bz = V[i2 + 2] - V[i0 + 2];
    const A = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    if (A < 1e-8) tiny++;
  }
  return { tiny, nTri, dirty: isFilletSliverDirty(tiny, nTri) };
}

const LOFT = `
const fr = { center: [0,0,0], normal: [0,0,1], x: [1,0,0], y: [0,1,0] };
const xs0 = makeCrossSection(fr, profileCircle(5, 32));
const xs1 = makeCrossSection(offsetPlaneFrame(fr, 20), profileRectangle(20, 12, true));
return placeInFrame(fr, makeLoft([xs0, xs1]));
`;

console.log('fillet C3 — loft Tangent-on + hard variable-profile WASM');

{
  const loft = await exec(LOFT);
  const g = geomOf(loft.mesh);
  const preDeg = countDegenerateTriangles(g);
  const raw = buildFeatureEdges(g);
  const topo = indexBoundaryEdges({
    positions: g.attributes.position.array,
    indices: g.index.array,
    faceIDs: loft.mesh.faceID,
  });
  const coherent = buildCoherentEdges(annotateFeatureEdges(raw, topo));
  check('loft coherent is human-scale', coherent.length > 0 && coherent.length < 80, `n=${coherent.length}`);

  const byChain = new Map();
  for (const e of coherent) {
    if (!byChain.has(e.chainId)) byChain.set(e.chainId, []);
    byChain.get(e.chainId).push(e);
  }
  let anyPick = 0;
  for (const segs of byChain.values()) {
    const picked = toggleEdgeSelectionPropagated([], segs[0], {
      propagate: true,
      featureEdges: coherent,
    });
    check(
      `tangent-on chain ${segs[0].chainId} non-empty ≤cap`,
      picked.length >= 1 && picked.length <= COHERENT_EDGE_MAX,
      `n=${picked.length}`,
    );
    anyPick = Math.max(anyPick, picked.length);
  }
  check('some loft chain selects >0 with Tangent on', anyPick >= 1);

  // Over-cap flood still soft-fails to seed (not empty).
  const flood = [];
  for (let i = 0; i < 48; i++) {
    flood.push({
      key: `f-${i}`, a: i, b: i + 1,
      va: [i * 0.4, 0, 0], vb: [(i + 1) * 0.4, 0, 0],
      mid: [(i + 0.5) * 0.4, 0, 0],
      length: 0.4, tangent: [1, 0, 0],
      n0: [0, 0, 1], n1: [0, 1, 0],
      chainId: 99,
    });
  }
  const flooded = toggleEdgeSelectionPropagated([], flood[0], {
    propagate: true,
    featureEdges: flood,
  });
  check('over-cap chain keeps seed (not 0)', flooded.length === 1, `n=${flooded.length}`);

  const generators = coherent.filter((e) => Math.abs(e.tangent[2]) > 0.8 && e.length > 10);
  check('loft has generator', generators.length >= 1);
  const gen = generators.sort((a, b) => b.length - a.length)[0];
  const radius = 1.6;
  const klass = classifyFilletEdges([gen], { radius, geometry: g });
  check('generator classified hard', klass.klass === 'hard', klass.klass);

  const loftStarter = `
const fr = { center: [0,0,0], normal: [0,0,1], x: [1,0,0], y: [0,1,0] };
const xs0 = makeCrossSection(fr, profileCircle(5, 32));
const xs1 = makeCrossSection(offsetPlaneFrame(fr, 20), profileRectangle(20, 12, true));
let part = placeInFrame(fr, makeLoft([xs0, xs1]));
return part;
`;
  const commit = composeFilletCommit(loftStarter, {
    edges: [gen],
    params: { strategy: 'sweep', radius, sphericalCorners: true },
    filletClass: klass.klass,
    geometry: g,
  });
  check('hard loft Accept ok', commit.ok === true, commit.message || '');
  check('hard loft emits variableProfile', /variableProfile:\s*true/.test(commit.buffer || ''));
  check('hard loft kernel', commit.kernel === 'variable-profile-sweep');

  let hardPayload = null;
  let hardErr = null;
  globalThis.__filletVariableProfileMeta = null;
  try {
    hardPayload = await exec(commit.buffer);
  } catch (e) {
    hardErr = e;
  }
  check('hard variable-profile exec succeeds', !!hardPayload && !hardErr, hardErr?.message || '');
  const vpMeta = globalThis.__filletVariableProfileMeta;
  check(
    'variableProfile used buildVariableProfileFrames (WASM pin)',
    !!vpMeta && vpMeta.usedFrames === true,
    vpMeta ? JSON.stringify(vpMeta) : 'meta missing — frames route bypassed',
  );
  check(
    'variableProfile densified frames > undensified segments',
    !!vpMeta && vpMeta.frameCount > vpMeta.rawSegCount,
    vpMeta ? `frames=${vpMeta.frameCount} rawSegs=${vpMeta.rawSegCount}` : 'meta missing',
  );
  check(
    'variableProfile strong inscribed-arc frames',
    !!vpMeta && vpMeta.strongFrames >= 1,
    vpMeta ? `strong=${vpMeta.strongFrames}` : 'meta missing',
  );
  if (hardPayload?.mesh) {
    const sc = sliverCount(hardPayload.mesh);
    check('hard result not scrap-sheet dirty', sc.dirty === false, `tiny=${sc.tiny}/${sc.nTri}`);
    const postDeg = countDegenerateTriangles(geomOf(hardPayload.mesh));
    const introduced = postDeg - preDeg;
    // Banner gate (Viewport): introduced > max(300, 10% of baseline).
    const wouldBanner = introduced > Math.max(300, 0.1 * Math.max(preDeg, 1));
    check(
      'hard loft R=1.6 would not raise zero-area banner',
      wouldBanner === false,
      `pre=${preDeg} post=${postDeg} introduced=${introduced}`,
    );
    // Geometry pin (B3): swept solid removes ~5 at R=1.6 on this loft fixture.
    // Bookkeeping-only WASM meta pins miss 8× over-cut (theta*0.6 → ~40 removed).
    const baseVol = loft.volume;
    const hardVol = hardPayload.volume;
    const removed = (Number.isFinite(baseVol) && Number.isFinite(hardVol))
      ? (baseVol - hardVol)
      : NaN;
    check(
      'hard loft R=1.6 removes ~5 volume (geometry pin)',
      Number.isFinite(removed) && removed > 3.5 && removed < 8,
      `base=${baseVol} hard=${hardVol} removed=${removed}`,
    );
  }
}

{
  const payload = await exec(`
    let part = Manifold.cube([40, 30, 20], true);
    const edges = convexEdges(part).filter((e) => Math.hypot(e.vb[0]-e.va[0], e.vb[1]-e.va[1], e.vb[2]-e.va[2]) > 30);
    const path = makeSweepPath([edges[0]]);
    return filletAlongPath(part, path, 3);
  `);
  const sc = sliverCount(payload.mesh);
  check('easy cube sweep stays clean', sc.dirty === false && sc.tiny === 0, `tiny=${sc.tiny}`);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nfillet C3 variable-profile golden passed');
