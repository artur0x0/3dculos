/**
 * Failed parts in the CAD viewer: red outline + tint on the part's solid.
 *
 * A part whose latest run failed contributes no fresh solid. The viewport
 * still shows its leftover (the last successful mesh) and, outside an
 * assembly, the restored last good mesh. Those solids are marked with the
 * strip / error-popup red (Tailwind red-400) so a stale solid never reads
 * as current. Successful parts carry no overlay.
 *
 * The overlay is one child group on the part mesh: feature edges
 * (EdgesGeometry), a translucent tint over the same geometry, and a glow
 * rim (the same geometry's back faces, scaled a few percent about the
 * solid's center, so a red silhouette shows around it). Neither
 * child raycasts, so picks still hit the solid only. The edge geometry is
 * rebuilt when the solid's geometry changes and disposed when it is off.
 */
import {
  BackSide,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
} from 'three';

/** Tailwind red-400, the feature strip failed border and the error popup. */
export const FAILED_PART_RED = 0xf87171;
export const FAILED_OUTLINE_NAME = 'failedPartOutline';
/** Crease angle for the outline edges (degrees). */
export const FAILED_OUTLINE_THRESHOLD_DEG = 20;

const noRaycast = () => {};

/** Glow rim scale for a solid of `size` mm: about 0.6 mm, 1–6 % of the size. */
export function failedGlowScale(size) {
  const s = Number(size);
  if (!(s > 0)) return 1.03;
  return 1 + Math.min(0.06, Math.max(0.01, 0.6 / s));
}

export function failedPartOutlineOf(mesh) {
  return mesh?.children?.find?.((child) => child?.name === FAILED_OUTLINE_NAME) || null;
}

function disposeOutline(mesh, outline) {
  if (!outline) return;
  mesh.remove(outline);
  outline.traverse((obj) => {
    if (obj.geometry && obj.userData?.ownsGeometry) obj.geometry.dispose();
    if (obj.material?.dispose) obj.material.dispose();
  });
}

/**
 * Turn the failed overlay on or off for one part mesh.
 * @param {import('three').Mesh|null} mesh
 * @param {boolean} on
 * @returns {boolean} whether the overlay is now shown
 */
export function setFailedPartOutline(mesh, on) {
  if (!mesh || typeof mesh.add !== 'function') return false;
  const prev = failedPartOutlineOf(mesh);
  const geom = mesh.geometry;
  const drawable = !!geom?.attributes?.position?.count;
  if (!on || !drawable) {
    disposeOutline(mesh, prev);
    if (mesh.userData) mesh.userData.failedOutline = false;
    return false;
  }
  if (prev && prev.userData.sourceGeometry === geom) return true;
  disposeOutline(mesh, prev);

  const group = new Group();
  group.name = FAILED_OUTLINE_NAME;
  group.userData = { sourceGeometry: geom };
  group.raycast = noRaycast;

  const edges = new LineSegments(
    new EdgesGeometry(geom, FAILED_OUTLINE_THRESHOLD_DEG),
    new LineBasicMaterial({ color: FAILED_PART_RED, transparent: true, opacity: 0.95 }),
  );
  edges.name = 'failedPartEdges';
  edges.userData = { ownsGeometry: true };
  edges.renderOrder = 6;
  edges.raycast = noRaycast;
  group.add(edges);

  const tint = new Mesh(geom, new MeshBasicMaterial({
    color: FAILED_PART_RED,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  }));
  tint.name = 'failedPartTint';
  tint.userData = { ownsGeometry: false };
  tint.renderOrder = 5;
  tint.raycast = noRaycast;
  group.add(tint);

  if (!geom.boundingBox) geom.computeBoundingBox();
  const box = geom.boundingBox;
  if (box && !box.isEmpty()) {
    const size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
    const scale = failedGlowScale(size);
    const glow = new Mesh(geom, new MeshBasicMaterial({
      color: FAILED_PART_RED,
      transparent: true,
      opacity: 0.85,
      side: BackSide,
      depthWrite: false,
    }));
    glow.name = 'failedPartGlow';
    glow.userData = { ownsGeometry: false };
    const cx = (box.min.x + box.max.x) / 2;
    const cy = (box.min.y + box.max.y) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    glow.scale.setScalar(scale);
    glow.position.set(cx * (1 - scale), cy * (1 - scale), cz * (1 - scale));
    glow.renderOrder = 4;
    glow.raycast = noRaycast;
    group.add(glow);
  }

  mesh.add(group);
  if (mesh.userData) mesh.userData.failedOutline = true;
  return true;
}

/**
 * Ids of visible parts whose latest run failed (same rule as the Parts
 * feed's red row: not missing, not blank, not skipped).
 */
export function failedPartIdsFor(doc, runs) {
  const out = [];
  for (const part of doc?.parts || []) {
    if (!part || part.visible === false) continue;
    const run = runs?.[part.id];
    if (run && run.ok === false && !run.empty && !run.skipped && !run.missing) out.push(String(part.id));
  }
  return out;
}
