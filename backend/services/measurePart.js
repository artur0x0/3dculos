/**
 * Measure the exported 3MF (the file the client already generated) and
 * return volume + one-part bounding box for the shared quote math.
 *
 * If the mesh cannot be measured and the failure is not fatal (too many
 * vertices), fall back to the client volume and bounding box after
 * `boundClientGeometry`. Client prices are never read here. See
 * docs/architecture.md.
 */
import JSZip from 'jszip';
import { boundClientGeometry } from '../../src/utils/quoteMath.js';
import {
  MeshMeasureError,
  geometryFromMesh,
  meshFrom3mfXml,
} from '../../src/utils/meshMeasure.js';

const CLIENT_BOUNDED_NOTE =
  'Server could not measure the exported mesh. Priced from the client volume and bounding box after bounds checks (positive, finite, inside the process build box, volume not larger than the box). Client prices are ignored.';

export async function measureExportedPart(modelData) {
  const process = modelData?.process;
  const raw = modelData?.modelFile?.data ?? modelData?.modelFile?.['data'];
  let note = null;

  if (raw) {
    try {
      const xml = await modelXmlFromPayload(raw);
      const geometry = geometryFromMesh(meshFrom3mfXml(xml));
      if (geometry.volume > 0) {
        return { ok: true, source: 'mesh', geometry, note: null };
      }
      note = 'Exported mesh volume was not positive.';
    } catch (err) {
      if (err instanceof MeshMeasureError && err.fatal) {
        return { ok: false, error: err.message };
      }
      note = err?.message || 'Could not read the exported mesh.';
    }
  } else {
    note = 'No exported model file was attached.';
  }

  const bounded = boundClientGeometry(modelData, process);
  if (!bounded.ok) {
    return { ok: false, error: bounded.error };
  }
  return {
    ok: true,
    source: 'client-bounded',
    geometry: bounded.geometry,
    note: `${note} ${CLIENT_BOUNDED_NOTE}`,
  };
}

async function modelXmlFromPayload(raw) {
  const cleaned = String(raw).replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.length === 0) {
    throw new MeshMeasureError('Empty model file');
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new MeshMeasureError('Model file is not a 3MF zip');
  }
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const modelName = names.find((name) => name.toLowerCase().endsWith('.model'));
  if (!modelName) throw new MeshMeasureError('No model file found in 3MF');
  return zip.files[modelName].async('string');
}
