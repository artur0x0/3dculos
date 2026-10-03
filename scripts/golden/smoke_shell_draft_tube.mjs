#!/usr/bin/env node
/**
 * Shell / Draft / Tube upgrades (WASM).
 *
 * Asserts, against the real kernel:
 * - shell()/hollow() wall thickness is UNIFORM on every axis (the old
 *   scale-based shell gave a 60x20 box a 2.5mm wall on Y and 7.5mm on X)
 * - the opening is a face SELECTION: an axis, 'none', a facesByNormal() face,
 *   or a Viewport-style {center, normal} pick — and it is the picked face that
 *   opens, not whatever the axis argument implied
 * - addDraft()/draftFaces() achieve the requested angle on EVERY wall, not just
 *   the narrowest one; single-face draft moves only that face; sign flips sense
 * - a bad face pick fails loudly instead of silently doing nothing
 * - tube() takes a rectangular cross-section ([w, d] + wall or inner size),
 *   with optional rounded corners
 */
import { register } from 'node:module';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
// Volumes come off a float32 mesh: compare relatively, not to the micron.
const nearVol = (a, b) => Math.abs(a - b) <= Math.max(1e-3, 1e-5 * Math.abs(b));

console.log('shell / draft / tube smoke');

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
      if (!workerSelf.onmessage) {
        reject(new Error('sandboxWorker handler missing'));
        return;
      }
      workerSelf.onmessage({ data: { type, payload, id } });
    });
  });
}

register('./manifold-resolve-hook.mjs', import.meta.url);
await import('../../src/workers/sandboxWorker.js');
await send('init');

async function exec(script) {
  const res = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
  return res.payload;
}
async function execFail(script) {
  try {
    await exec(script);
    return null;
  } catch (e) {
    return e.message || String(e);
  }
}

/** Distinct vertex coordinates on one axis, rounded, ascending. */
function coords(mesh, axis) {
  const np = mesh.numProp || 3;
  const set = new Set();
  for (let i = 0; i < mesh.vertProperties.length; i += np) {
    set.add(Math.round(mesh.vertProperties[i + axis] * 1000) / 1000);
  }
  return [...set].sort((a, b) => a - b);
}
/** Extreme coordinate on `axis` among vertices whose other coords are near c. */
function extentAt(mesh, axis, pickAxis, pickValue, tol = 1e-3) {
  const np = mesh.numProp || 3;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < mesh.vertProperties.length; i += np) {
    if (Math.abs(mesh.vertProperties[i + pickAxis] - pickValue) > tol) continue;
    const v = mesh.vertProperties[i + axis];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}

// ── 1. Uniform wall on a deliberately non-square box ─────────────────
{
  console.log('\nuniform wall thickness');
  const W = 60, D = 20, H = 20, t = 2.5;
  const p = await exec(`
    let part = Manifold.cube([${W}, ${D}, ${H}], true);
    part = hollow(part, ${t}, 'z');
    return part;
  `);
  const xs = coords(p.mesh, 0);
  const ys = coords(p.mesh, 1);
  // The inner wall must sit exactly t in from the outer wall on BOTH axes.
  check('X walls at ±30 and ±27.5', JSON.stringify(xs) === JSON.stringify([-30, -27.5, 27.5, 30]),
    `got ${JSON.stringify(xs)}`);
  check('Y walls at ±10 and ±7.5', JSON.stringify(ys) === JSON.stringify([-10, -7.5, 7.5, 10]),
    `got ${JSON.stringify(ys)}`);
  // Open at +Z: cavity is (W-2t)(D-2t)(H-t).
  const wallVol = W * D * H - (W - 2 * t) * (D - 2 * t) * (H - t);
  check('open-top wall volume exact', nearVol(p.volume, wallVol),
    `got ${p.volume.toFixed(4)} want ${wallVol.toFixed(4)}`);

  // subtract(shell(...)) — the historical call site — must agree.
  const legacy = await exec(`
    let part = Manifold.cube([${W}, ${D}, ${H}], true);
    part = part.subtract(shell(part, ${t}, 'z'));
    return part;
  `);
  check('subtract(shell(...)) matches hollow()', nearVol(legacy.volume, p.volume),
    `${legacy.volume.toFixed(4)} vs ${p.volume.toFixed(4)}`);
}

// ── 2. Opening is a face selection ───────────────────────────────────
{
  console.log('\nopening by face');
  const S = 40, t = 2;
  const closed = await exec(`
    let part = Manifold.cube([${S}, ${S}, ${S}], true);
    part = hollow(part, ${t}, 'none');
    return part;
  `);
  check("'none' gives a fully closed hollow",
    nearVol(closed.volume, S ** 3 - (S - 2 * t) ** 3),
    `got ${closed.volume.toFixed(3)}`);

  const openX = await exec(`
    let part = Manifold.cube([${S}, ${S}, ${S}], true);
    const f = facesByNormal(part, [1, 0, 0])[0];
    part = hollow(part, ${t}, f);
    return part;
  `);
  const expectX = S ** 3 - (S - t) * (S - 2 * t) * (S - 2 * t);
  check('facesByNormal(+X) face opens +X', nearVol(openX.volume, expectX),
    `got ${openX.volume.toFixed(3)} want ${expectX.toFixed(3)}`);
  // The +X face is gone: no vertex ring closes the cavity at x=+20.
  const atMaxX = extentAt(openX.mesh, 1, 0, S / 2);
  check('+X face is an opening, not a wall', near(atMaxX.lo, -S / 2) && near(atMaxX.hi, S / 2));

  const pick = await exec(`
    let part = Manifold.cube([${S}, ${S}, ${S}], true);
    // shape of a Viewport face pick
    part = hollow(part, ${t}, { center: [0, -${S / 2}, 0], normal: [0, -1, 0] });
    return part;
  `);
  check('Viewport-style {center, normal} pick opens -Y', nearVol(pick.volume, expectX),
    `got ${pick.volume.toFixed(3)}`);

  const two = await exec(`
    let part = Manifold.cube([${S}, ${S}, ${S}], true);
    part = hollow(part, ${t}, ['z', '-z']);
    return part;
  `);
  check('array opens both caps',
    nearVol(two.volume, S ** 3 - (S - 2 * t) * (S - 2 * t) * S),
    `got ${two.volume.toFixed(3)}`);

  const err = await execFail(`
    let part = Manifold.cube([${S}, ${S}, ${S}], true);
    part = hollow(part, ${t}, { center: [0, 0, 999], normal: [0, 0, 1] });
    return part;
  `);
  check('stale face pick fails loudly', !!err && /re-pick/.test(err), err || 'no throw');

  const thick = await execFail(`
    let part = Manifold.cube([10, 10, 10], true);
    part = hollow(part, 6, 'z');
    return part;
  `);
  check('too-thick wall fails loudly', !!thick, thick || 'no throw');
}

// ── 3. Shell a cylinder: wall measured off the curved face ───────────
{
  console.log('\nshelled cylinder');
  const R = 20, H = 30, t = 3, SEG = 64;
  const p = await exec(`
    let part = Manifold.cylinder(${H}, ${R}, ${R}, ${SEG});
    part = hollow(part, ${t}, 'z');
    return part;
  `);
  // Inscribed polygon radii: outer apothem*? — compare against the polygonal
  // areas the kernel actually builds, not the ideal circle.
  const poly = (r) => 0.5 * SEG * r * r * Math.sin((2 * Math.PI) / SEG);
  const apo = Math.cos(Math.PI / SEG);
  const expect = poly(R) * H - poly(R - t / apo) * (H - t);
  check('cylinder wall volume within 1% of offset-polygon prediction',
    Math.abs(p.volume - expect) / expect < 0.01,
    `got ${p.volume.toFixed(2)} want ~${expect.toFixed(2)}`);
  check('outer radius untouched', near(p.boundingBox.max[0], R * apo, 1e-2)
    || near(p.boundingBox.max[0], R, 1e-2), `max x ${p.boundingBox.max[0]}`);
}

// ── 4. Draft: same angle on every wall ───────────────────────────────
{
  console.log('\ndraft angle');
  const W = 60, D = 20, H = 20, deg = 5;
  const p = await exec(`
    let part = Manifold.cube([${W}, ${D}, ${H}], false);
    part = addDraft(part, ${deg}, 'z');
    return part;
  `);
  const drop = H * Math.tan((deg * Math.PI) / 180);
  const topX = extentAt(p.mesh, 0, 2, H);
  const topY = extentAt(p.mesh, 1, 2, H);
  const botX = extentAt(p.mesh, 0, 2, 0);
  check('bottom (reference plane) unmoved', near(botX.lo, 0) && near(botX.hi, W));
  check('long wall drafted by tan(5°)·H', near(topX.hi, W - drop, 1e-3) && near(topX.lo, drop, 1e-3),
    `top X ${topX.lo.toFixed(4)}..${topX.hi.toFixed(4)} want ${drop.toFixed(4)}..${(W - drop).toFixed(4)}`);
  check('short wall drafted by the SAME amount',
    near(topY.hi, D - drop, 1e-3) && near(topY.lo, drop, 1e-3),
    `top Y ${topY.lo.toFixed(4)}..${topY.hi.toFixed(4)}`);

  // Single face, from a reference plane, both signs.
  const one = await exec(`
    let part = Manifold.cube([${W}, ${D}, ${H}], false);
    part = draftFaces(part, facesByNormal(part, [1, 0, 0])[0], ${deg}, { pull: 'z', reference: 'min' });
    return part;
  `);
  const oneTop = extentAt(one.mesh, 0, 2, H);
  check('single-face draft moves only that face',
    near(oneTop.hi, W - drop, 1e-3) && near(oneTop.lo, 0, 1e-6),
    `top X ${oneTop.lo.toFixed(4)}..${oneTop.hi.toFixed(4)}`);

  const flared = await exec(`
    let part = Manifold.cube([${W}, ${D}, ${H}], false);
    part = draftFaces(part, facesByNormal(part, [1, 0, 0])[0], -${deg}, { pull: 'z', reference: 'min' });
    return part;
  `);
  check('negative angle flares outward',
    near(extentAt(flared.mesh, 0, 2, H).hi, W + drop, 1e-3),
    `top X max ${extentAt(flared.mesh, 0, 2, H).hi.toFixed(4)}`);

  const mid = await exec(`
    let part = Manifold.cube([${W}, ${D}, ${H}], false);
    part = draftFaces(part, 'sides', ${deg}, { pull: 'z', reference: 'mid' });
    return part;
  `);
  const half = (H / 2) * Math.tan((deg * Math.PI) / 180);
  check('reference: mid pivots at half height',
    near(extentAt(mid.mesh, 0, 2, H).hi, W - half, 1e-3)
    && near(extentAt(mid.mesh, 0, 2, 0).hi, W + half, 1e-3),
    `top ${extentAt(mid.mesh, 0, 2, H).hi.toFixed(4)} bottom ${extentAt(mid.mesh, 0, 2, 0).hi.toFixed(4)}`);

  const cap = await execFail(`
    let part = Manifold.cube([${W}, ${D}, ${H}], false);
    part = draftFaces(part, facesByNormal(part, [0, 0, 1])[0], ${deg}, { pull: 'z' });
    return part;
  `);
  check('drafting a cap fails loudly', !!cap && /perpendicular/.test(cap), cap || 'no throw');

  // Shell then draft — the mould-ready combination, inner wall drafted the
  // other way so the core releases.
  const both = await exec(`
    let part = Manifold.cube([${W}, ${D}, ${H}], false);
    part = hollow(part, 2.5, 'z');
    part = addDraft(part, 2, 'z');
    return part;
  `);
  check('hollow + draft stays a valid solid', both.status === 'NoError' && both.volume > 0,
    `${both.status} vol ${both.volume}`);
}

// ── 5. Rectangular tube ──────────────────────────────────────────────
{
  console.log('\nrectangular tube');
  const w = 40, d = 20, h = 60, wall = 2.5;
  const p = await exec(`return tube([${w}, ${d}], ${wall}, ${h});`);
  check('wall-thickness form: exact volume',
    near(p.volume, (w * d - (w - 2 * wall) * (d - 2 * wall)) * h, 1e-3),
    `got ${p.volume.toFixed(3)}`);
  check('bbox is w x d x h',
    near(p.boundingBox.min[0], -w / 2) && near(p.boundingBox.max[0], w / 2)
    && near(p.boundingBox.min[1], -d / 2) && near(p.boundingBox.max[1], d / 2)
    && near(p.boundingBox.min[2], 0) && near(p.boundingBox.max[2], h),
    JSON.stringify(p.boundingBox));

  const inner = await exec(`return tube([${w}, ${d}], [30, 10], ${h});`);
  check('explicit inner size form', near(inner.volume, (w * d - 30 * 10) * h, 1e-3),
    `got ${inner.volume.toFixed(3)}`);

  const sq = await exec(`return rectTube(30, 3, 20);`);
  check('scalar outer means square', near(sq.volume, (30 * 30 - 24 * 24) * 20, 1e-3),
    `got ${sq.volume.toFixed(3)}`);

  const round = await exec(`return tube([${w}, ${d}], ${wall}, ${h}, { cornerRadius: 4 });`);
  check('rounded corners remove material but keep the bbox',
    round.volume < p.volume && round.volume > p.volume * 0.9
    && near(round.boundingBox.max[0], w / 2, 1e-2),
    `got ${round.volume.toFixed(3)} vs sharp ${p.volume.toFixed(3)}`);

  const circ = await exec(`return tube(15, 10, 40, 32);`);
  check('round tube unchanged (back-compat)', circ.volume > 0 && circ.status === 'NoError');

  const bad = await execFail(`return tube([20, 20], 12, 10);`);
  check('too-thick rect wall fails loudly', !!bad && /too thick/.test(bad), bad || 'no throw');
}

// ── 6. Palette wiring: the face pick reaches the emitted script ──────
{
  console.log('\npalette composition');
  const { composeHelperInsert } = await import('../../src/utils/helperPaletteSnippets.js');
  const { resolveFaceModal, classifySelectedFace, isFaceFeature } =
    await import('../../src/utils/faceFeaturePlacement.js');

  check('shell is a face feature', isFaceFeature('shell'));
  check('draft is a face feature', isFaceFeature('addDraft'));

  const pick = (center, normal, extra = {}) => ({
    center, normal, area: 400, triangleCount: 2, selectionMode: 'coplanar', ...extra,
  });

  // No face picked: the axis form still composes, and now via hollow().
  const noFace = composeHelperInsert('', 'shell', null, { wall: 2, openScope: 'z' });
  check('axis shell composes to hollow()', /hollow\(\s*\w+,\s*2,\s*'z'\s*\)/.test(noFace), noFace);

  const shellItem = { id: 'shell', title: 'Shell', params: [] };
  const face = classifySelectedFace(pick([0, 0, 10], [0, 0, 1]));
  const modal = resolveFaceModal(shellItem, pick([0, 0, 10], [0, 0, 1]));
  check('shell gets a face-aware sheet', modal.mode === 'params'
    && modal.item.params.some((p) => p.name === 'openScope'), modal.mode);
  check("openScope defaults to the pick", modal.item.params
    .find((p) => p.name === 'openScope')?.default === 'selected');

  const faceShell = composeHelperInsert('', 'shell', null, { wall: 2, openScope: 'selected' }, face);
  check('picked face becomes an opening literal',
    /hollow\(\s*\w+,\s*2,\s*\{ center: \[0, 0, 10\], normal: \[0, 0, 1\] \}\)/.test(faceShell),
    faceShell);

  // Draft picker: neutral face supplies pull + reference. No world-axis guess,
  // no addDraft(), no shift-click. Signed angle still allowed.
  const {
    composeDraftCommit, applyDraftFaceTap, emptyDraftState,
  } = await import('../../src/utils/draftMode.js');
  const neutralZ = { center: [0, 0, 10], normal: [0, 0, 1] };
  const xPlus = { center: [20, 0, 0], normal: [1, 0, 0] };
  const xMinus = { center: [-20, 0, 0], normal: [-1, 0, 0] };
  let drafted = applyDraftFaceTap(emptyDraftState(), neutralZ);
  drafted = applyDraftFaceTap(drafted, xPlus);
  drafted = { ...drafted, angle: -3 };
  const oneFace = composeDraftCommit('', drafted);
  check('single-face draft emits the pick, the sign and the neutral reference',
    oneFace.ok
    && /draftFaces\(\s*part,\s*\[\{ center: \[20, 0, 0\], normal: \[1, 0, 0\] \}\],\s*-3,\s*\{ pull: \[0, 0, 1\], reference: \{ center: \[0, 0, 10\], normal: \[0, 0, 1\] \} \}\)/.test(oneFace.buffer)
    && !/addDraft\s*\(/.test(oneFace.buffer)
    && !/pull:\s*'/.test(oneFace.buffer),
    oneFace.buffer || oneFace.message);
  check('draft angle still allows a negative', drafted.angle === -3 && /-3/.test(oneFace.buffer || ''));

  drafted = applyDraftFaceTap(emptyDraftState(), neutralZ);
  drafted = applyDraftFaceTap(drafted, xPlus);
  drafted = applyDraftFaceTap(drafted, xMinus);
  drafted = { ...drafted, angle: 2 };
  const multiDraft = composeDraftCommit('', drafted);
  check('two picked faces emit one draftFaces array',
    multiDraft.ok
    && (multiDraft.buffer.match(/draftFaces\s*\(/g) || []).length === 1
    && /\[\{ center: \[20, 0, 0\], normal: \[1, 0, 0\] \}, \{ center: \[-20, 0, 0\], normal: \[-1, 0, 0\] \}\]/.test(multiDraft.buffer)
    && !/addDraft\s*\(/.test(multiDraft.buffer),
    multiDraft.buffer || multiDraft.message);
  const chip = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../src/components/DraftModeChip.jsx', import.meta.url), 'utf8'));
  check('draft chip angle goes negative', /min=\{-45\}/.test(chip));

  // And the emitted multi-face draft actually runs.
  const ran = await exec(`
    let part = Manifold.cube([40, 20, 20], false);
    part = draftFaces(part, [
      { center: [40, 10, 10], normal: [1, 0, 0] },
      { center: [0, 10, 10], normal: [-1, 0, 0] },
    ], 5, { pull: 'z', reference: 'min' });
    return part;
  `);
  const drop5 = 20 * Math.tan((5 * Math.PI) / 180);
  const top = extentAt(ran.mesh, 0, 2, 20);
  check('both picked faces drafted, Y walls untouched',
    near(top.lo, drop5, 1e-3) && near(top.hi, 40 - drop5, 1e-3)
    && near(extentAt(ran.mesh, 1, 2, 20).hi, 20, 1e-6),
    `top X ${top.lo.toFixed(4)}..${top.hi.toFixed(4)}`);

  // Tube: the rectangular section reaches the script.
  const rect = composeHelperInsert('', 'tube', null,
    { section: 'rect', width: 40, depth: 20, wall: 2.5, height: 60, cornerRadius: 4 });
  check('rect tube composes with corner radius',
    /tube\(\[40, 20\], 2\.5, 60, \{ cornerRadius: 4 \}\)/.test(rect), rect);
  const roundT = composeHelperInsert('', 'tube', null,
    { section: 'round', outerRadius: 15, innerRadius: 10, height: 40, segments: 64 });
  check('round tube unchanged by the new sheet', /tube\(15, 10, 40, 64\)/.test(roundT), roundT);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
