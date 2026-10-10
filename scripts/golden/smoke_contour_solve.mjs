/**
 * Contour solver. No Manifold. No screenshots.
 *
 * A fixed rectangle solves. Dropping the lengths is under-defined, not a
 * conflict. A second horizontal is a repeated warning. Perpendicular plus
 * parallel conflicts and names both. 129 points throw. A corner arc is
 * tangent. A circle tessellates like profileCircle.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CONTOUR_POINT_CAP,
  analyzeContour,
  contourFromCircle,
  contourFromPolyline,
  contourFromRectangle,
  roundContourCorner,
  solveContour,
} from '../../src/utils/contourSolve.js';
import { emitSolveContour, parseSolveContour } from '../../src/utils/contourScript.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const at = (solved, id) => solved.points.find((p) => p.id === id).at;

console.log('rectangle — fully defined');
{
  const solved = solveContour(contourFromRectangle(40, 20, true));
  check('status full', solved.status === 'full', solved.status);
  check('dof 0', solved.dof === 0, `dof ${solved.dof}`);
  check('no conflict', solved.conflict == null);
  check('no repeated', solved.repeated.length === 0, JSON.stringify(solved.repeated));
  check('p0', near(at(solved, 'p0')[0], -20) && near(at(solved, 'p0')[1], -10), at(solved, 'p0').join(','));
  check('p1', near(at(solved, 'p1')[0], 20) && near(at(solved, 'p1')[1], -10), at(solved, 'p1').join(','));
  check('p2', near(at(solved, 'p2')[0], 20) && near(at(solved, 'p2')[1], 10));
  check('closed contour', solved.contours[0].length === 4);
  const again = solveContour(solved);
  check('second solve matches the call', emitSolveContour(solved) === emitSolveContour(again));
}

console.log('under-defined — not a conflict');
{
  const spec = contourFromRectangle(40, 20, true);
  spec.dimensions = [];
  const solved = solveContour(spec);
  check('status under', solved.status === 'under', solved.status);
  check('dof > 0', solved.dof > 0, `dof ${solved.dof}`);
  check('residual is not a conflict', solved.conflict == null);
}

console.log('repeated horizontal');
{
  const spec = contourFromRectangle(40, 20, true);
  spec.constraints.push({ id: 'k9', kind: 'horizontal', items: ['e0'] });
  const solved = solveContour(spec);
  check('still full', solved.status === 'full', solved.status);
  check('not a conflict', solved.conflict == null);
  check('later copy is repeated', solved.repeated.some((r) => r.id === 'k9' && r.warning === 'repeated'),
    JSON.stringify(solved.repeated));
  check('the earlier horizontal is kept', !solved.repeated.some((r) => r.id === 'k0'));
}

console.log('parallel and perpendicular conflict');
{
  const spec = {
    points: [
      { id: 'p0', at: [0, 0] },
      { id: 'p1', at: [10, 1] },
      { id: 'p2', at: [1, 10] },
    ],
    lines: [
      { id: 'e0', a: 'p0', b: 'p1' },
      { id: 'e1', a: 'p0', b: 'p2' },
    ],
    arcs: [],
    dimensions: [
      { id: 'd0', kind: 'length', edge: 'e0', value: 10 },
      { id: 'd1', kind: 'length', edge: 'e1', value: 10 },
    ],
    constraints: [
      { id: 'k0', kind: 'parallel', items: ['e0', 'e1'] },
      { id: 'k1', kind: 'perpendicular', items: ['e0', 'e1'] },
      { id: 'k2', kind: 'fix', items: ['p0'], at: { p0: [0, 0] } },
    ],
  };
  const solved = solveContour(spec);
  check('status conflict', solved.status === 'conflict', solved.status);
  check('does not throw and still returns points', solved.points.length === 3);
  const ids = solved.conflict?.ids || [];
  check('names both constraints', ids.includes('k0') && ids.includes('k1'), ids.join(','));
  check('repeated is empty on a conflict', solved.repeated.length === 0);
}

console.log('point cap');
{
  const points = [];
  for (let i = 0; i < CONTOUR_POINT_CAP + 1; i += 1) points.push([i, 0]);
  let message = '';
  try { solveContour(contourFromPolyline(points)); } catch (err) { message = err.message; }
  check('129 points throw', /128/.test(message), message);
}

console.log('polyline closes at the third point');
{
  const open = contourFromPolyline([[0, 0], [10, 0]]);
  check('two points stay open', open.lines.length === 1);
  const closed = contourFromPolyline([[0, 0], [10, 0], [10, 5]]);
  check('three points have a closing line', closed.lines.length === 3);
  const solved = solveContour(closed);
  check('under-defined and closed', solved.status === 'under' && solved.contours[0].length === 3,
    `${solved.status} n=${solved.contours[0]?.length}`);
}

console.log('circle tessellation matches profileCircle');
{
  const solved = solveContour(contourFromCircle(5, 32));
  check('status full', solved.status === 'full', `${solved.status} dof ${solved.dof}`);
  const ring = solved.contours[0];
  check('32 segments', ring.length === 32, String(ring.length));
  check('starts at +u', near(ring[0][0], 5) && near(ring[0][1], 0), ring[0].join(','));
  let ok = true;
  for (let i = 0; i < 32; i += 1) {
    const t = (i / 32) * Math.PI * 2;
    if (!near(ring[i][0], 5 * Math.cos(t), 1e-6) || !near(ring[i][1], 5 * Math.sin(t), 1e-6)) ok = false;
  }
  check('same samples as profileCircle', ok);
}

console.log('corner arc');
{
  const spec = contourFromPolyline([[0, 0], [10, 0], [10, 10]]);
  const rounded = roundContourCorner(spec, ['e0', 'e1'], 2);
  const solved = solveContour(rounded);
  const arc = solved.arcs[0];
  check('one arc', solved.arcs.length === 1);
  check('radius 2', near(arc.radius, 2, 1e-4), String(arc.radius));
  check('two tangents', solved.constraints.filter((c) => c.kind === 'tangent').length === 2);
  const center = at(solved, arc.center);
  check('center sits inside the corner', near(center[0], 8, 1e-3) && near(center[1], 2, 1e-3), center.join(','));
  check('not a conflict', solved.status !== 'conflict', solved.status);
}

console.log('three-segment corner');
{
  const spec = contourFromPolyline([[0, 0], [8, 0], [10, 2], [10, 12]]);
  const rounded = roundContourCorner(spec, ['e0', 'e1', 'e2'], 2);
  check('middle line is gone', !rounded.lines.some((l) => l.id === 'e1'));
  const solved = solveContour(rounded);
  check('arc radius held', near(solved.arcs[0].radius, 2, 1e-3), String(solved.arcs[0].radius));
  check('solves', solved.status !== 'conflict', solved.status);
}

console.log('script call');
{
  const spec = contourFromRectangle(40, 12, false);
  spec.dimensions[0].name = 'width';
  const src = emitSolveContour(spec);
  check('name is a string', src.includes("name: 'width'"));
  check('no const binding', !src.includes('const width'));
  const parsed = parseSolveContour(src);
  check('round trip', emitSolveContour(parsed) === src);
  let message = '';
  try { parseSolveContour('solveContour({ points: [], lines: [], arcs: [], dimensions: [{ id: \'d0\', kind: \'length\', edge: \'e0\', value: width }], constraints: [] })'); }
  catch (err) { message = err.message; }
  check('bare identifier refused', /number or a string/.test(message), message);
  let bad = '';
  try { solveContour({ points: [{ id: 'p0', at: [0, 0] }], lines: [{ id: 'e0', a: 'p0', b: 'p9' }], arcs: [], dimensions: [], constraints: [] }); }
  catch (err) { bad = err.message; }
  check('unknown id throws', /p9/.test(bad), bad);
}

console.log('helper is registered');
{
  const runtime = readFileSync(join(root, 'src/lib/surfcad/runtime.js'), 'utf8');
  const block = runtime.slice(runtime.indexOf('const HELPER_FUNCTIONS = {'), runtime.indexOf('\n};', runtime.indexOf('const HELPER_FUNCTIONS = {')));
  check('solveContour is a helper', /^\s*solveContour,/m.test(block));
  check('makeCrossSection names it', runtime.includes('solveContour, a { type } descriptor'));
}

console.log('angle stays on the branch');
{
  const spec = {
    points: [
      { id: 'p0', at: [0, 0] },
      { id: 'p1', at: [10, 2] },
      { id: 'p2', at: [2, 10] },
    ],
    lines: [
      { id: 'e0', a: 'p0', b: 'p1' },
      { id: 'e1', a: 'p0', b: 'p2' },
    ],
    arcs: [],
    dimensions: [
      { id: 'd0', kind: 'length', edge: 'e0', value: 10 },
      { id: 'd1', kind: 'length', edge: 'e1', value: 10 },
      { id: 'd2', kind: 'angle', a: 'e0', b: 'e1', value: 90, sense: 1 },
    ],
    constraints: [
      { id: 'k0', kind: 'horizontal', items: ['e0'] },
      { id: 'k1', kind: 'fix', items: ['p0'], at: { p0: [0, 0] } },
    ],
  };
  const solved = solveContour(spec);
  check('angle solve is not a conflict', solved.status !== 'conflict', `${solved.status} dof ${solved.dof}`);
  check('p1 on +u', near(at(solved, 'p1')[0], 10, 1e-4) && near(at(solved, 'p1')[1], 0, 1e-4), at(solved, 'p1').join(','));
  check('p2 on +v', near(at(solved, 'p2')[0], 0, 1e-4) && near(at(solved, 'p2')[1], 10, 1e-4), at(solved, 'p2').join(','));
  const analyzed = analyzeContour(spec);
  check('analyze keeps a nullspace array', Array.isArray(analyzed.nullspace));
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\ncontour solver ok');
