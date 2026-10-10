#!/usr/bin/env node
/**
 * Angled lofts: profiles on planes that are not parallel.
 *
 * - 90° elbow, square to circle. A straight ruling is the chord of the bend;
 *   the solid must bow onto the spine (a vertex the chord cannot reach).
 * - Two planes about 30° apart, with a lateral offset.
 * - Mismatched vertex counts (triangle vs circle).
 *
 * Each case must be one genus-0 body, positive volume, valid manifold
 * status, and no proper triangle-triangle self-intersection.
 * Screenshots go to GOLDEN_SHOT_DIR or os.tmpdir() only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import Module from '../../built/manifold.js';
import { buildMakeLoftSolid } from '../../src/utils/makeLoft.js';
import { loftMeshSelfIntersects } from '../../src/utils/makeLoftAngled.js';
import { runScript } from '../../src/lib/surfcad/index.js';

const shotDir = process.env.GOLDEN_SHOT_DIR || tmpdir();

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function circle(r, n = 48) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return pts;
}

function square(side) {
  const h = side / 2;
  return [[-h, -h], [h, -h], [h, h], [-h, h]];
}

const planeA = {
  center: [0, 0, 0],
  normal: [0, 0, 1],
  x: [1, 0, 0],
  y: [0, 1, 0],
};

/** Right-handed frame, normal +X, Y stays world +Y. */
const planeElbow = {
  center: [25, 0, 25],
  normal: [1, 0, 0],
  x: [0, 0, -1],
  y: [0, 1, 0],
};

const deg = Math.PI / 180;
const c30 = Math.cos(30 * deg);
const s30 = Math.sin(30 * deg);
/** 30° tilt about Y, plus a +Y offset of the center. */
const planeSkew = {
  center: [18, 10, 40],
  normal: [s30, 0, c30],
  x: [c30, 0, -s30],
  y: [0, 1, 0],
};

function statusOk(solid) {
  if (!solid || typeof solid.status !== 'function') return false;
  const s = solid.status();
  if (typeof s === 'string') return s === 'NoError';
  if (s && typeof s.value === 'number') return s.value === 0;
  return s != null;
}

function meshOf(solid) {
  const mesh = solid.getMesh();
  const np = mesh.numProp || 3;
  const verts = [];
  const n = mesh.vertProperties.length / np;
  for (let i = 0; i < n; i++) {
    verts.push([
      mesh.vertProperties[i * np],
      mesh.vertProperties[i * np + 1],
      mesh.vertProperties[i * np + 2],
    ]);
  }
  return { verts, triVerts: mesh.triVerts, numProp: np, raw: mesh };
}

function nearest(verts, p, pred) {
  let best = Infinity;
  for (const v of verts) {
    if (pred && !pred(v)) continue;
    const d = Math.hypot(v[0] - p[0], v[1] - p[1], v[2] - p[2]);
    if (d < best) best = d;
  }
  return best;
}

console.log('angled loft');

const wasm = await Module();
wasm.setup();
const { Manifold, CrossSection, Mesh } = wasm;

{
  const cube = Manifold.cube([10, 10, 10], true);
  const cm = cube.getMesh();
  check(
    'self-intersection check is quiet on a cube',
    loftMeshSelfIntersects(cm.vertProperties, cm.triVerts, cm.numProp) === false,
  );
  const crossing = loftMeshSelfIntersects(
    [0, 0, 0, 2, 0, 0, 0, 2, 0, 0.2, 0.2, -1, 0.2, 0.2, 1, 1.5, 1.5, 0],
    [0, 1, 2, 3, 4, 5],
    3,
  );
  check('self-intersection check catches crossing triangles', crossing === true);
}

const opts = { Mesh, resolution: 64 };
const shots = [];

function adopt(name, solid) {
  const parts = typeof solid.decompose === 'function' ? solid.decompose() : [];
  const mesh = meshOf(solid);
  const self = loftMeshSelfIntersects(mesh.raw.vertProperties, mesh.raw.triVerts, mesh.numProp);
  check(`${name}: valid manifold status`, statusOk(solid), String(solid.status && solid.status()));
  check(`${name}: positive volume`, solid.volume() > 1e-6, `vol=${solid.volume()}`);
  check(`${name}: genus 0`, solid.genus() === 0, `genus=${solid.genus()}`);
  check(`${name}: one body`, parts.length === 1, `bodies=${parts.length}`);
  check(`${name}: no self-intersection`, self === false);
  for (const p of parts) {
    if (p && p !== solid && typeof p.delete === 'function') p.delete();
  }
  return mesh;
}

// ── 90° elbow: square on z=0, circle on the plane x=25 ────────
let elbow = null;
{
  elbow = buildMakeLoftSolid(Manifold, CrossSection, [
    { plane: planeA, contours: [square(10)] },
    { plane: planeElbow, contours: [circle(5, 48)] },
  ], opts);
  const mesh = adopt('elbow', elbow);
  const vol = elbow.volume();
  check('elbow volume in the duct band (3300–3750)', vol > 3300 && vol < 3750, `vol=${vol.toFixed(1)}`);
  const bb = elbow.boundingBox();
  check(
    'elbow stays within the profile in Y (no 45° twist)',
    bb.min[1] > -5.2 && bb.max[1] < 5.2 && bb.min[1] < -4.8 && bb.max[1] > 4.8,
    `y ${bb.min[1].toFixed(2)}..${bb.max[1].toFixed(2)}`,
  );
  check(
    'elbow meets both planes',
    bb.min[2] > -0.05 && bb.min[2] < 0.05 && bb.max[0] > 24.9 && bb.max[0] < 25.05,
    `bb ${bb.min.map((v) => v.toFixed(2))} ${bb.max.map((v) => v.toFixed(2))}`,
  );
  let witness = 0;
  for (const v of mesh.verts) {
    if (v[2] > 16 && v[0] < 12) witness++;
  }
  check(
    'elbow follows the spine, not the straight chord',
    witness > 20,
    `vertices with z>16 and x<12: ${witness}`,
  );
  const corners = [[-5, -5, 0], [5, -5, 0], [5, 5, 0], [-5, 5, 0]];
  const cornerErr = Math.max(...corners.map((c) => nearest(mesh.verts, c)));
  check('square corners survive resampling', cornerErr < 0.05, `err=${cornerErr.toExponential(2)}`);
  let onCircle = 0;
  for (const v of mesh.verts) {
    if (Math.abs(v[0] - 25) > 0.05) continue;
    const r = Math.hypot(v[1], v[2] - 25);
    if (r > 4.7 && r < 5.2) onCircle++;
  }
  check('end cap is the circle on its plane', onCircle > 30, `samples=${onCircle}`);
  shots.push({ name: 'loft-angled-elbow.png', title: '90° elbow', mesh });
}

// Same elbow with the end normal reversed (frame stays right-handed).
{
  const flipped = {
    center: [25, 0, 25],
    normal: [-1, 0, 0],
    x: [0, 0, -1],
    y: [0, -1, 0],
  };
  const solid = buildMakeLoftSolid(Manifold, CrossSection, [
    { plane: planeA, contours: [square(10)] },
    { plane: flipped, contours: [circle(5, 48)] },
  ], opts);
  const rel = Math.abs(solid.volume() - elbow.volume()) / elbow.volume();
  check(
    'reversed end normal keeps winding and volume',
    solid.genus() === 0 && rel < 0.01,
    `rel=${(rel * 100).toFixed(3)}% genus=${solid.genus()}`,
  );
}

{
  let msg = '';
  try {
    buildMakeLoftSolid(Manifold, CrossSection, [
      { plane: planeA, contours: [square(20)] },
      {
        plane: { center: [8, 0, 8], normal: [1, 0, 0], x: [0, 0, -1], y: [0, 1, 0] },
        contours: [circle(12, 32)],
      },
    ], { Mesh, resolution: 48 });
  } catch (e) {
    msg = (e && e.message) || String(e);
  }
  check(
    'tight 90° turn fails loud instead of a broken solid',
    /self-intersect/i.test(msg),
    msg || 'did not throw',
  );
}

{
  let msg = '';
  try {
    buildMakeLoftSolid(Manifold, CrossSection, [
      { plane: planeA, contours: [square(10)] },
      {
        plane: { center: [25, 0, 25], normal: [1, 0, 0], x: [0, 0, 1], y: [0, 1, 0] },
        contours: [circle(5, 24)],
      },
    ], opts);
  } catch (e) {
    msg = (e && e.message) || String(e);
  }
  check(
    'left-handed plane fails loud',
    /right-handed/i.test(msg),
    msg || 'did not throw',
  );
}

// ── 30° skew with a lateral offset ────────────────────────────
{
  const rect = [[-10, -6], [10, -6], [10, 6], [-10, 6]];
  const solid = buildMakeLoftSolid(Manifold, CrossSection, [
    { plane: planeA, contours: [rect] },
    { plane: planeSkew, contours: [circle(6, 40)] },
  ], opts);
  const mesh = adopt('skew', solid);
  const vol = solid.volume();
  check('skew volume in band (7000–8200)', vol > 7000 && vol < 8200, `vol=${vol.toFixed(1)}`);
  const bb = solid.boundingBox();
  check(
    'skew keeps the base and the offset circle',
    bb.min[1] < -5 && bb.max[1] > 14,
    `y ${bb.min[1].toFixed(2)}..${bb.max[1].toFixed(2)}`,
  );
  const n = planeSkew.normal;
  const c = planeSkew.center;
  let onPlane = 0;
  let ySum = 0;
  for (const v of mesh.verts) {
    const d = n[0] * (v[0] - c[0]) + n[1] * (v[1] - c[1]) + n[2] * (v[2] - c[2]);
    if (Math.abs(d) < 0.05) {
      onPlane++;
      ySum += v[1];
    }
  }
  check('skew end cap lies on the tilted plane', onPlane > 30, `onPlane=${onPlane}`);
  check(
    'skew end cap sits at the +Y offset',
    onPlane > 0 && ySum / onPlane > 8,
    `mean y=${onPlane ? (ySum / onPlane).toFixed(2) : 'n/a'}`,
  );
  shots.push({ name: 'loft-angled-skew.png', title: '30° skew', mesh });
}

// ── mismatched vertex counts: triangle (3) to circle (40) ─────
{
  const tri = [[0, 10], [-9, -5], [9, -5]];
  const solid = buildMakeLoftSolid(Manifold, CrossSection, [
    { plane: planeA, contours: [tri] },
    { plane: planeSkew, contours: [circle(8, 40)] },
  ], opts);
  const mesh = adopt('mismatch', solid);
  const vol = solid.volume();
  check('mismatch volume in band (6800–8200)', vol > 6800 && vol < 8200, `vol=${vol.toFixed(1)}`);
  const cornerErr = Math.max(...tri.map((p) => nearest(mesh.verts, [p[0], p[1], 0], (v) => Math.abs(v[2]) < 0.2)));
  check(
    'triangle vertices land on the start cap',
    cornerErr < 1,
    `err=${cornerErr.toFixed(3)}`,
  );
  const n = planeSkew.normal;
  const c = planeSkew.center;
  const cap = mesh.verts.filter((v) => {
    const d = n[0] * (v[0] - c[0]) + n[1] * (v[1] - c[1]) + n[2] * (v[2] - c[2]);
    return Math.abs(d) < 0.05;
  });
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const v of cap) {
    cx += v[0];
    cy += v[1];
    cz += v[2];
  }
  cx /= cap.length || 1;
  cy /= cap.length || 1;
  cz /= cap.length || 1;
  let minR = Infinity;
  let maxR = 0;
  for (const v of cap) {
    const r = Math.hypot(v[0] - cx, v[1] - cy, v[2] - cz);
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
  }
  const spread = maxR > 1e-6 ? (maxR - minR) / maxR : 1;
  check(
    'circle end stays round despite the triangle start',
    cap.length > 30 && spread < 0.08,
    `samples=${cap.length} spread=${spread.toFixed(3)}`,
  );
  shots.push({ name: 'loft-angled-mismatch.png', title: 'triangle to circle', mesh });
}

// Script path: makeLoft + placeInFrame, same elbow volume.
{
  const src = `
const A = { center: [0,0,0], normal: [0,0,1], x: [1,0,0], y: [0,1,0] };
const B = { center: [25,0,25], normal: [1,0,0], x: [0,0,-1], y: [0,1,0] };
const xs0 = makeCrossSection(A, profileRectangle(10, 10));
const xs1 = makeCrossSection(B, profileCircle(5, 48));
return placeInFrame(A, makeLoft([xs0, xs1], { resolution: 64 }));
`;
  const run = await runScript(src);
  const rel = Math.abs(run.volume - elbow.volume()) / elbow.volume();
  check(
    'makeLoft script matches the direct elbow',
    run.bodyCount === 1 && rel < 0.01 && (run.status === 'NoError' || run.status == null || run.status === 0),
    `vol=${run.volume.toFixed(2)} bodies=${run.bodyCount} status=${run.status} rel=${(rel * 100).toFixed(3)}%`,
  );
}

// ── screenshots (software raster, no WebGL) ───────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderShot(mesh) {
  const w = 640;
  const h = 480;
  const { verts, triVerts } = mesh;
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) {
    for (let k = 0; k < 3; k++) {
      if (v[k] < min[k]) min[k] = v[k];
      if (v[k] > max[k]) max[k] = v[k];
    }
  }
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const ext = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1);
  const eye = [center[0] + ext * 1.15, center[1] + ext * 0.85, center[2] + ext * 1.05];
  const fwd = norm(sub(center, eye));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const light = norm([0.35, 0.85, 0.4]);
  const cam = verts.map((v) => {
    const d = sub(v, eye);
    return [dot(d, right), dot(d, up), dot(d, fwd)];
  });
  let span = 0;
  for (const p of cam) span = Math.max(span, Math.abs(p[0]), Math.abs(p[1]));
  const scale = (Math.min(w, h) * 0.42) / (span || 1);
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = 22;
    rgb[i * 3 + 1] = 24;
    rgb[i * 3 + 2] = 28;
  }
  const tris = [];
  for (let i = 0; i < triVerts.length; i += 3) {
    const ia = triVerts[i];
    const ib = triVerts[i + 1];
    const ic = triVerts[i + 2];
    const a = cam[ia];
    const b = cam[ib];
    const c = cam[ic];
    const n = cross(sub(verts[ib], verts[ia]), sub(verts[ic], verts[ia]));
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    const nd = Math.abs(n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / nl;
    const shade = 0.38 + 0.62 * nd;
    tris.push({
      z: (a[2] + b[2] + c[2]) / 3,
      shade,
      p: [a, b, c],
    });
  }
  tris.sort((a, b) => a.z - b.z);
  for (const tri of tris) {
    const pts = tri.p.map((p) => [w / 2 + p[0] * scale, h / 2 - p[1] * scale]);
    fillTri(rgb, w, h, pts, tri.shade);
  }
  let lit = 0;
  for (let i = 0; i < w * h; i++) {
    if (rgb[i * 3] > 40) lit++;
  }
  return { png: encodePng(w, h, rgb), lit };
}

function fillTri(rgb, w, h, pts, shade) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  let x0 = Math.max(0, Math.floor(Math.min(...xs)));
  let x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  let y0 = Math.max(0, Math.floor(Math.min(...ys)));
  let y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  const area = edge(pts[0], pts[1], pts[2]);
  if (Math.abs(area) < 1e-6) return;
  const cr = Math.round(168 * shade);
  const cg = Math.round(188 * shade);
  const cb = Math.round(204 * shade);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = [x + 0.5, y + 0.5];
      const w0 = edge(pts[1], pts[2], p) / area;
      const w1 = edge(pts[2], pts[0], p) / area;
      const w2 = edge(pts[0], pts[1], p) / area;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
        const i = (y * w + x) * 3;
        rgb[i] = cr;
        rgb[i + 1] = cg;
        rgb[i + 2] = cb;
      }
    }
  }
}

function edge(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function norm(v) {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}

mkdirSync(shotDir, { recursive: true });
for (const shot of shots) {
  const { png, lit } = renderShot(shot.mesh);
  const file = join(shotDir, shot.name);
  writeFileSync(file, png);
  check(`${shot.title} screenshot has the solid`, lit > 4000, `lit=${lit} ${file}`);
  console.log(`  shot ${file}`);
}

if (failed) {
  console.error(`\nFAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log('\nAll angled-loft checks passed.');
