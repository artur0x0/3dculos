/**
 * Sheet-metal viewport overlay (three.js): plane pick quads, the live
 * preview of the spec (+ draft feature), and fat pick handles for edges.
 * Every pickable object carries userData.sm = { kind, … } for the tap router.
 * Built in the part's local frame; Viewport anchors it to the active part.
 */
import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Shape,
  Vector3,
} from 'three';
import { SHEET_PLANES, normalizeSheetSpec, panelPoint, sheetFreeEdges, solveSheet, vAdd, vMul } from './sheetModel.js';

const COLORS = {
  plane: 0xfb923c,
  planeHot: 0xf97316,
  metal: 0xcbd5e1,
  draft: 0x22d3ee,
  edge: 0xf97316,
  edgeHot: 0x22d3ee,
  hole: 0x0f172a,
};

const basis = (X, Y, Z, o) => new Matrix4()
  .makeBasis(new Vector3(...X), new Vector3(...Y), new Vector3(...Z))
  .setPosition(new Vector3(...o));

function boxMesh(X, Y, Z, origin, sx, sy, sz, material, sm) {
  if (!(sx > 1e-6 && sy > 1e-6 && sz > 1e-6)) return null;
  const g = new BoxGeometry(sx, sy, sz);
  g.translate(sx / 2, sy / 2, sz / 2);
  g.applyMatrix4(basis(X, Y, Z, origin));
  const m = new Mesh(g, material);
  if (sm) m.userData.sm = sm;
  return m;
}

function sectorMesh(bend, t, r, material, sm) {
  if (!(bend.theta > 1e-6) || !(bend.q1 - bend.q0 > 1e-6)) return null;
  const n = Math.max(2, Math.ceil((bend.theta / (Math.PI / 2)) * 12));
  const pt = (rad, phi) => (bend.flip
    ? [rad * Math.sin(phi), rad * Math.cos(phi)]
    : [rad * Math.sin(phi), -rad * Math.cos(phi)]);
  const shape = new Shape();
  const first = pt(r + t, 0);
  shape.moveTo(first[0], first[1]);
  for (let i = 1; i <= n; i++) shape.lineTo(...pt(r + t, (bend.theta * i) / n));
  for (let i = n; i >= 0; i--) shape.lineTo(...pt(Math.max(r, 1e-4), (bend.theta * i) / n));
  const g = new ExtrudeGeometry(shape, { depth: bend.q1 - bend.q0, bevelEnabled: false, curveSegments: 1 });
  const origin = vAdd(bend.axis, vMul(bend.q1, bend.e));
  g.applyMatrix4(basis(bend.d, bend.N, vMul(-1, bend.e), origin));
  const m = new Mesh(g, material);
  if (sm) m.userData.sm = sm;
  return m;
}

/** Translucent plane quads for the base-flange plane pick (S2). */
function planeQuads(group, hot = null, size = 80) {
  for (const p of Object.values(SHEET_PLANES)) {
    const g = new PlaneGeometry(size, size);
    // PlaneGeometry lies in XY facing +Z → map to (U, V, N).
    g.applyMatrix4(basis(p.U, p.V, p.N, [0, 0, 0]));
    const mat = new MeshBasicMaterial({
      color: p.id === hot ? COLORS.planeHot : COLORS.plane,
      transparent: true,
      opacity: p.id === hot ? 0.45 : 0.22,
      side: DoubleSide,
      depthWrite: false,
    });
    const m = new Mesh(g, mat);
    m.userData.sm = { kind: 'plane', plane: p.id };
    m.renderOrder = 5;
    group.add(m);
  }
}

/**
 * mode = { stage, spec, draft?: { kind, … }, tool }
 * Returns a Group (caller anchors + adds to scene) or null.
 */
export function buildSheetOverlay(mode) {
  if (!mode) return null;
  const group = new Group();
  group.name = 'sheetMetalOverlay';
  if (mode.stage === 'plane') {
    planeQuads(group, mode.hoverPlane || null);
    return group;
  }
  const spec = normalizeSheetSpec(mode.previewSpec || mode.spec);
  if (!spec) return group;
  let solved;
  try {
    solved = solveSheet(spec);
  } catch {
    return group;
  }
  const metal = new MeshLambertMaterial({ color: COLORS.metal, transparent: true, opacity: 0.92 });
  const draftMat = new MeshLambertMaterial({ color: COLORS.draft, transparent: true, opacity: 0.75 });
  const draftId = mode.draft?.id || null;
  const matFor = (id) => (draftId && id === draftId ? draftMat : metal);
  for (const p of solved.panels) {
    const m = boxMesh(p.U, p.V, p.N, panelPoint(p, p.u0, p.v0, 0), p.u1 - p.u0, p.v1 - p.v0, spec.t,
      matFor(p.id === 'base' && mode.stage === 'base' ? draftId : p.id), { kind: 'panel', panel: p.id });
    if (m) group.add(m);
  }
  for (const b of solved.bends) {
    const m = sectorMesh(b, spec.t, spec.r, matFor(b.id), { kind: 'bend', id: b.id });
    if (m) group.add(m);
  }
  for (const tab of solved.tabs) {
    const m = boxMesh(tab.d, tab.e, tab.N, vAdd(tab.E0, vMul(tab.q0, tab.e)), tab.depth, tab.q1 - tab.q0, spec.t,
      matFor(tab.id), { kind: 'tab', id: tab.id });
    if (m) group.add(m);
  }
  const holeMat = new MeshBasicMaterial({ color: COLORS.hole });
  for (const h of solved.holes) {
    const d = Number(h.d) || 0;
    if (!(d > 0)) continue;
    const g = new CylinderGeometry(d / 2, d / 2, spec.t * 1.2, 32);
    // Cylinder axis is +Y → map Y to the panel normal.
    const p = h.panelRef;
    g.applyMatrix4(basis(p.U, p.N, vMul(-1, p.V), vAdd(h.center, vMul(spec.t / 2, p.N))));
    const m = new Mesh(g, draftId === h.id ? draftMat : holeMat);
    m.userData.sm = { kind: 'hole', id: h.id };
    group.add(m);
  }
  // Edge handles: fat, translucent, only for the active tool.
  if (mode.stage === 'edit' && !mode.draft && (mode.tool === 'bend' || mode.tool === 'tab')) {
    const hot = mode.hotEdge ? `${mode.hotEdge.panel}:${mode.hotEdge.edge}` : '';
    // Fat enough for a fingertip at fit-to-view zoom.
    const size = Math.max(4, spec.t * 3, Math.max(spec.width, spec.height) * 0.05);
    for (const e of sheetFreeEdges(spec, solved)) {
      if (mode.tool === 'bend' ? !e.bendable : !e.tabbable) continue;
      if (!(e.length > 1e-3)) continue;
      const dir = new Vector3(...e.b).sub(new Vector3(...e.a));
      const len = dir.length();
      const g = new BoxGeometry(size, len, size);
      const mid = new Vector3(...e.a).add(new Vector3(...e.b)).multiplyScalar(0.5);
      const m = new Mesh(g, new MeshBasicMaterial({
        color: `${e.panel}:${e.edge}` === hot ? COLORS.edgeHot : COLORS.edge,
        transparent: true,
        opacity: `${e.panel}:${e.edge}` === hot ? 0.7 : 0.35,
        depthWrite: false,
      }));
      m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
      m.position.copy(mid);
      m.renderOrder = 6;
      m.userData.sm = { kind: 'edge', panel: e.panel, edge: e.edge };
      group.add(m);
    }
  }
  return group;
}

/** First sheet-metal pick in a raycast hit list. */
export function sheetPickFromHits(hits) {
  for (const hit of hits || []) {
    const sm = hit?.object?.userData?.sm;
    if (sm) return { ...sm, point: hit.point ? [hit.point.x, hit.point.y, hit.point.z] : null };
  }
  return null;
}

export function disposeSheetOverlay(scene, group) {
  if (!group) return;
  scene?.remove(group);
  group.traverse((obj) => {
    obj.geometry?.dispose?.();
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) m?.dispose?.();
  });
}
