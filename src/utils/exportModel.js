// utils/exportModel.js
// 3MF export functionality (only format supported)

import { saveAs } from 'file-saver';
import manifoldContext from './ManifoldWorker';
import { export3MF, blobToBase64 } from './model-io';
import { meshResolveError, resolvePartMeshes } from './meshAssets.js';

/**
 * Generate a 3MF blob from the current script
 * @param {string} currentScript - The Manifold script to execute
 * @returns {Promise<Blob>} The 3MF file as a Blob
 */
export async function generate3MFBlob(currentScript, options = {}) {
  if (!currentScript) {
    throw new Error('No script provided');
  }

  if (!manifoldContext.isReady) {
    try {
      await manifoldContext.init();
    } catch (err) {
      throw new Error(err?.message || 'Manifold worker not initialized');
    }
  }
  if (!manifoldContext.isReady) {
    throw new Error('Manifold worker not initialized');
  }

  const lineError = options.lineError || '';
  let importedModels = options.importedModels;
  if (!importedModels) {
    let prepared;
    try {
      prepared = await resolvePartMeshes(options.partId, currentScript);
    } catch (err) {
      throw new Error(lineError || err?.message || 'Missing mesh asset');
    }
    if (prepared.missing.length) {
      throw new Error(meshResolveError(prepared.missing, lineError));
    }
    importedModels = prepared.importedModels;
  }

  // Execute script via worker to get mesh data
  let result;
  try {
    result = await manifoldContext.executeScript(currentScript, { importedModels });
  } catch (err) {
    const message = err?.message || 'Could not export this part.';
    if (/mesh asset|importMesh/i.test(message)) {
      throw new Error(lineError || message);
    }
    throw err instanceof Error ? err : new Error(message);
  }
  
  if (!result || !result.mesh) {
    throw new Error('Invalid manifold result for export');
  }

  return export3MF(result.mesh, 'model', {
    unit: 'millimeter',
    title: 'Manifold Model',
    designer: 'Manifold Web CAD'
  });
}

/**
 * Generate a 3MF blob from existing mesh data (avoids re-execution)
 * @param {Object} meshData - Mesh data from previous execution
 * @param {Object} options - Export options
 * @returns {Promise<Blob>} The 3MF file as a Blob
 */
export async function generate3MFBlobFromMesh(meshData, options = {}) {
  if (!meshData || !meshData.vertProperties) {
    throw new Error('Invalid mesh data for export');
  }

  return export3MF(meshData, options.name || 'model', {
    unit: options.unit || 'millimeter',
    title: options.title || 'Manifold Model',
    designer: options.designer || 'Manifold Web CAD'
  });
}

/**
 * Export 3MF as base64 string (for API/database storage)
 * @param {string} currentScript - The Manifold script to execute
 * @returns {Promise<string>} Base64 encoded 3MF file
 */
export async function get3MFBase64(currentScript) {
  const blob = await generate3MFBlob(currentScript);
  return blobToBase64(blob);
}

/**
 * Export 3MF as base64 from existing mesh data
 * @param {Object} meshData - Mesh data from previous execution
 * @returns {Promise<string>} Base64 encoded 3MF file
 */
export async function get3MFBase64FromMesh(meshData) {
  const blob = await generate3MFBlobFromMesh(meshData);
  return blobToBase64(blob);
}

/**
 * Download model as 3MF file
 * @param {string} currentScript - The Manifold script to execute
 * @param {string} filename - Filename without extension (default: 'model')
 */
export async function downloadModel(currentScript, filename = 'model') {
  try {
    const blob = await generate3MFBlob(currentScript);
    saveAs(blob, `${filename}.3mf`);
    console.log('[Export] 3MF exported successfully');
  } catch (error) {
    console.error('[Export] Error exporting 3MF:', error);
    throw error;
  }
}

/**
 * Download model from existing mesh data (avoids re-execution)
 * @param {Object} meshData - Mesh data from previous execution
 * @param {string} filename - Filename without extension (default: 'model')
 */
export async function downloadModelFromMesh(meshData, filename = 'model') {
  try {
    const blob = await generate3MFBlobFromMesh(meshData);
    saveAs(blob, `${filename}.3mf`);
    console.log('[Export] 3MF exported successfully');
  } catch (error) {
    console.error('[Export] Error exporting 3MF:', error);
    throw error;
  }
}

export default {
  generate3MFBlob,
  generate3MFBlobFromMesh,
  get3MFBase64,
  get3MFBase64FromMesh,
  downloadModel,
  downloadModelFromMesh
};
