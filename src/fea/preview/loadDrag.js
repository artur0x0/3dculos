/**
 * Live load edits for the preview sliders.
 *
 * Magnitude keeps the current direction. The direction slider rotates the
 * force in the plane of the loaded face. Nothing here writes the part
 * script; the panel commits once when the pointer goes up.
 */

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 0)) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function tangentBasis(normal) {
  const n = normalize(normal || [0, 0, 1]);
  const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const t = normalize(cross(n, ref));
  const b = cross(n, t);
  return { n, t, b };
}

export function vectorFromAngle(normal, magnitude, angleDeg) {
  const { t, b } = tangentBasis(normal);
  const angle = (Number(angleDeg) || 0) * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const mag = Number(magnitude) || 0;
  return [
    (t[0] * c + b[0] * s) * mag,
    (t[1] * c + b[1] * s) * mag,
    (t[2] * c + b[2] * s) * mag,
  ];
}

export function angleFromVector(normal, vector) {
  const { t, b } = tangentBasis(normal);
  const v = vector || [0, 0, 0];
  const x = dot(v, t);
  const y = dot(v, b);
  let deg = Math.atan2(y, x) * 180 / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

export function scaledVector(vector, magnitude) {
  const v = vector || [0, 0, 0];
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 0)) return [0, 0, -Math.abs(Number(magnitude) || 0)];
  const scale = (Number(magnitude) || 0) / len;
  return [v[0] * scale, v[1] * scale, v[2] * scale];
}

export function withLoadVector(study, index, vector) {
  const loads = (study?.loads || []).map((load, i) => (
    i === index ? { ...load, vector: [vector[0], vector[1], vector[2]] } : load
  ));
  return { ...study, loads };
}

export function withMaterial(study, material) {
  return { ...study, material };
}

/**
 * Study the sliders are previewing. Magnitude and angle describe the
 * selected force. A material id replaces the library pick. This object is
 * not written until pointer-up.
 */
export function sliderFromLoad(study, loadIndex, materialIds) {
  const loads = study?.loads || [];
  let index = loadIndex;
  if (!loads[index] || loads[index].kind !== 'force') {
    index = loads.findIndex((load) => load.kind === 'force');
  }
  const ids = materialIds || [];
  const found = ids.indexOf(study?.material?.id);
  const materialIndex = found;
  if (index < 0) {
    return { loadIndex: 0, magnitude: 200, angle: 0, materialIndex, hasForce: false };
  }
  const load = loads[index];
  const vector = load.vector || [0, 0, -1];
  return {
    loadIndex: index,
    magnitude: Math.hypot(vector[0], vector[1], vector[2]) || 0,
    angle: angleFromVector(load.faces?.[0]?.n, vector),
    materialIndex,
    hasForce: true,
  };
}

export function studyForPreview(study, { loadIndex = 0, magnitude = 0, angle = 0, materialId = '' } = {}) {
  const load = study?.loads?.[loadIndex];
  if (!load || load.kind !== 'force') return null;
  const normal = load.faces?.[0]?.n || [0, 0, 1];
  const vector = vectorFromAngle(normal, magnitude, angle);
  let next = withLoadVector(study, loadIndex, vector);
  if (materialId && next.material?.id !== materialId) next = withMaterial(next, { id: materialId });
  return next;
}
