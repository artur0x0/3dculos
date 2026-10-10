/**
 * Node-to-surface inputs for solve_contact.
 *
 * Master is contact.a, slave is contact.b, the same ends as a bonded tie.
 * Node ids are concatenated across bodies. Bonded pairs are not included;
 * those stay on the projection-MPC path.
 */

import { DEFAULT_FRICTION } from './contactDetect.js';

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

export function frictionalStudy(study) {
  return (study?.contacts || []).some((contact) => (
    contact
    && contact.enabled !== false
    && (contact.kind === 'frictionless' || contact.kind === 'frictional')
  ));
}

/** One wasm surface per enabled frictionless or frictional pair. */
export function buildContactPayload(bodies, contacts, gap) {
  const list = Array.isArray(bodies) ? bodies : [];
  const surfaces = [];
  const distance = typeof gap === 'number' && gap > 0 ? gap : 0.05;
  for (const contact of contacts || []) {
    if (!contact || contact.enabled === false) continue;
    if (contact.kind !== 'frictionless' && contact.kind !== 'frictional') continue;
    const master = list.find((body) => String(body.id) === String(contact.a?.part));
    const slave = list.find((body) => String(body.id) === String(contact.b?.part));
    if (!master || !slave) continue;
    const masterSide = facesAndNodes(master.mesh, contact.a.faceID);
    const slaveSide = facesAndNodes(slave.mesh, contact.b.faceID);
    if (!masterSide.faces.length || !slaveSide.faces.length || !slaveSide.nodes.length) continue;
    const masterFaces = [];
    const slaveFaces = [];
    for (const face of masterSide.faces) {
      for (let k = 0; k < 6; k += 1) masterFaces.push(face[k] + master.nodeOffset);
    }
    for (const face of slaveSide.faces) {
      for (let k = 0; k < 6; k += 1) slaveFaces.push(face[k] + slave.nodeOffset);
    }
    const slaves = slaveSide.nodes.map((node) => node + slave.nodeOffset);
    const mu = contact.kind === 'frictional'
      ? (typeof contact.mu === 'number' && contact.mu >= 0 ? contact.mu : DEFAULT_FRICTION)
      : 0;
    surfaces.push({
      slaves: Uint32Array.from(slaves),
      masterFaces: Uint32Array.from(masterFaces),
      slaveFaces: Uint32Array.from(slaveFaces),
      law: contact.kind,
      mu,
      gap: distance,
    });
  }
  return surfaces;
}

/** Manifold face ids that belong to an enabled non-bonded pair on this part. */
export function contactFaceIds(study, partId) {
  const ids = new Set();
  for (const contact of study?.contacts || []) {
    if (!contact || contact.enabled === false) continue;
    if (contact.kind !== 'frictionless' && contact.kind !== 'frictional') continue;
    if (String(contact.a?.part) === String(partId)) ids.add(Number(contact.a.faceID));
    if (String(contact.b?.part) === String(partId)) ids.add(Number(contact.b.faceID));
  }
  return ids;
}
