/**
 * Expand a stored study face onto every Manifold triangle of that wall.
 *
 * The part script keeps one faceID (the majority id on the paint patch).
 * Some meshes give each triangle its own id, so a rectangular wall is two
 * ids. The solve request carries the whole set. The script itself is unchanged.
 */

import { matchFaceKeys } from '../utils/faceColorMatch.js';
import { fingerprintsFromGeometry } from '../utils/facePaint.js';
import { faceKeyOf } from './studyPanel.js';

function idsForFace(face, prints, faceIDs) {
  const ids = new Set();
  const stored = Number(face && face.faceID);
  if (Number.isInteger(stored) && stored >= 0) ids.add(stored);
  const key = faceKeyOf(face);
  if (key && prints.length && faceIDs) {
    const { matched } = matchFaceKeys(prints, [{ key }]);
    for (const row of matched) {
      const tris = row.face && row.face.tris ? row.face.tris : [];
      for (let i = 0; i < tris.length; i += 1) {
        const id = Number(faceIDs[tris[i]]);
        if (Number.isInteger(id) && id >= 0) ids.add(id);
      }
    }
  }
  return [...ids];
}

function mapFaces(faces, prints, faceIDs) {
  if (!Array.isArray(faces)) return faces;
  return faces.map((face) => ({
    ...face,
    triangleFaceIDs: idsForFace(face, prints, faceIDs),
  }));
}

/** A copy of the study whose faces list every triangle id on the picked wall. */
export function studyForSolve(study, geometry, faceIDs) {
  if (!study) return study;
  const prints = fingerprintsFromGeometry(geometry, faceIDs);
  const mapEntry = (entry) => ({
    ...entry,
    faces: mapFaces(entry && entry.faces, prints, faceIDs),
  });
  return {
    ...study,
    fixtures: Array.isArray(study.fixtures) ? study.fixtures.map(mapEntry) : study.fixtures,
    loads: Array.isArray(study.loads) ? study.loads.map(mapEntry) : study.loads,
  };
}
