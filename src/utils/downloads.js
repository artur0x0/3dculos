import { saveAs } from 'file-saver';
import { 
  BufferGeometry, 
  BufferAttribute, 
  Mesh as ThreeMesh, 
  MeshBasicMaterial 
} from 'three';

/**
 * Generate a 3MF blob from the current script
 * @param {string} currentScript - The Manifold script to execute
 * @returns {Promise<Blob>} The 3MF file as a Blob
 */
export async function generate3MFBlob(currentScript) {
  if (!currentScript) {
    throw new Error('No script provided');
  }

  // Use global Manifold instance
  if (!window.Manifold) {
    throw new Error('Manifold WASM not loaded');
  }
  
  const wasm = window.Manifold;

  // Re-execute to get fresh Manifold result
  const wasmKeys = Object.keys(wasm);
  const wasmValues = Object.values(wasm);
  const scriptFn = new Function(...wasmKeys, currentScript);
  const result = scriptFn(...wasmValues);

  if (!result || typeof result.getMesh !== 'function') {
    throw new Error('Invalid manifold result for export');
  }

  const manifoldMesh = result.getMesh();

  // Convert to Three.js BufferGeometry
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(manifoldMesh.vertProperties, 3));
  geometry.setIndex(new BufferAttribute(manifoldMesh.triVerts, 1));

  // Create a Three.js Mesh
  const mesh = new ThreeMesh(geometry, new MeshBasicMaterial());

  // Import the exporter and export to Blob
  const { exportTo3MF } = await import('three-3mf-exporter');
  const blob = await exportTo3MF(mesh);

  return blob;
}

/**
 * Export 3MF as base64 string (for API uploads)
 * @param {string} currentScript - The Manifold script to execute
 * @returns {Promise<string>} Base64 encoded 3MF file
 */
export async function export3MFBase64(currentScript) {
  try {
    const blob = await generate3MFBlob(currentScript);
    
    // Convert blob to base64
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('Error converting 3MF to base64:', error);
    throw error;
  }
}

/**
 * Download 3MF file to user's machine
 * @param {string} currentScript - The Manifold script to execute
 * @param {string} filename - Optional filename (default: 'model.3mf')
 */
export async function downloadModel(currentScript, filename = 'model.3mf') {
  try {
    const blob = await generate3MFBlob(currentScript);
    saveAs(blob, filename);
    console.log('3MF exported successfully');
  } catch (error) {
    console.error('Error exporting 3MF:', error);
    throw error;
  }
}