/**
 * Projection-MPC inputs for solve_bonded.
 *
 * Master is contact.a, slave is contact.b. Node ids are concatenated:
 * body 0 keeps its indices, body 1 starts at body 0's node count.
 * Each slave node may land on any TET10 face of that master Manifold face.
 */

function facesAndNodes(mesh, faceID) {
  const wanted = Number(faceID);
  const faceIds = mesh?.faceIds;
  const faces = mesh?.faces;
  const found = [];
  const nodes = [];
  const seen = new Set();
  if (!faceIds || !faces) return { faces: found, nodes };
  for (let f = 0; f < faceIds.length; f += 1) {
    if (Number(faceIds[f]) !== wanted) continue;
    const ids = [];
    for (let k = 0; k < 6; k += 1) {
      const id = faces[f * 6 + k];
      ids.push(id);
      if (!seen.has(id)) {
        seen.add(id);
        nodes.push(id);
      }
    }
    found.push(ids);
  }
  return { faces: found, nodes };
}

/**
 * `bodies` are `{ id, nodeOffset, mesh }` in concatenated order.
 * Disabled pairs are skipped. Returns the typed arrays solve_bonded reads.
 */
export function buildTiePayload(bodies, contacts, gap) {
  const slaveNodes = [];
  const masterFaces = [];
  const faceOffsets = [];
  const faceCounts = [];
  const list = Array.isArray(bodies) ? bodies : [];
  for (const contact of contacts || []) {
    if (!contact || contact.enabled === false || contact.kind !== 'bonded') continue;
    const master = list.find((body) => String(body.id) === String(contact.a?.part));
    const slave = list.find((body) => String(body.id) === String(contact.b?.part));
    if (!master || !slave) continue;
    const masterSide = facesAndNodes(master.mesh, contact.a.faceID);
    const slaveSide = facesAndNodes(slave.mesh, contact.b.faceID);
    if (!masterSide.faces.length || !slaveSide.nodes.length) continue;
    const base = masterFaces.length / 6;
    for (const face of masterSide.faces) {
      for (let k = 0; k < 6; k += 1) masterFaces.push(face[k] + master.nodeOffset);
    }
    for (const node of slaveSide.nodes) {
      slaveNodes.push(node + slave.nodeOffset);
      faceOffsets.push(base);
      faceCounts.push(masterSide.faces.length);
    }
  }
  return {
    slaveNodes: Uint32Array.from(slaveNodes),
    masterFaces: Uint32Array.from(masterFaces),
    faceOffsets: Uint32Array.from(faceOffsets),
    faceCounts: Uint32Array.from(faceCounts),
    gap: typeof gap === 'number' && gap > 0 ? gap : 0.05,
  };
}
