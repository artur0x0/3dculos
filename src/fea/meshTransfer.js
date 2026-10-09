/**
 * Prepare mesh typed arrays for a worker postMessage transfer.
 *
 * Arrays that already own their buffer are transferred as-is. A subview, or
 * any set of views that share one buffer, is copied first so the transfer
 * list is three distinct ArrayBuffers and the caller's other views stay
 * usable. Plain arrays are rejected: the contract is typed arrays.
 */

function requireView(name, value, Ctor) {
  if (!(value instanceof Ctor)) {
    throw new TypeError(`mesh.${name} must be a ${Ctor.name}`);
  }
  return value;
}

function ownsWholeBuffer(view) {
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength;
}

export function packMesh(mesh) {
  if (!mesh || typeof mesh !== 'object') {
    throw new TypeError('mesh is required');
  }
  let positions = requireView('positions', mesh.positions, Float32Array);
  let indices = requireView('indices', mesh.indices, Uint32Array);
  const faceSource = mesh.faceIDs ?? mesh.faceID;
  let faceIDs = requireView('faceIDs', faceSource, Uint32Array);

  const shared = new Set([positions.buffer, indices.buffer, faceIDs.buffer]).size !== 3;
  if (shared) {
    positions = positions.slice();
    indices = indices.slice();
    faceIDs = faceIDs.slice();
  } else {
    if (!ownsWholeBuffer(positions)) positions = positions.slice();
    if (!ownsWholeBuffer(indices)) indices = indices.slice();
    if (!ownsWholeBuffer(faceIDs)) faceIDs = faceIDs.slice();
  }

  return {
    positions,
    indices,
    faceIDs,
    transfer: [positions.buffer, indices.buffer, faceIDs.buffer],
  };
}
