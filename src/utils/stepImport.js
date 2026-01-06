// utils/stepImport.js
const DB_NAME = 'SurfDB';
const DB_VERSION = 1;
const STORE_NAME = 'models';

/**
 * Initialize IndexedDB for caching manifold data
 */
const initDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'filename' });
      }
    };
  });
};

/**
 * Cache manifold data in IndexedDB
 */
export const cacheManifoldData = async (filename, data) => {
  try {
    const db = await initDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    await store.put({
      filename,
      data,
      timestamp: Date.now()
    });
    
    console.log(`[Cache] Stored ${filename} in IndexedDB`);
  } catch (error) {
    console.error('[Cache] Error storing data:', error);
  }
};

/**
 * Retrieve cached manifold data from IndexedDB
 */
export const getCachedManifoldData = async (filename) => {
  try {
    const db = await initDB();
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    
    return new Promise((resolve, reject) => {
      const request = store.get(filename);
      request.onsuccess = () => {
        const result = request.result;
        if (result) {
          console.log(`[Cache] Retrieved ${filename} from IndexedDB`);
          resolve(result.data);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('[Cache] Error retrieving data:', error);
    return null;
  }
};

/**
 * Convert STEP file to Manifold via backend
 * Server handles: STEP → 3MF → Manifold conversion
 */
export const convertStepToManifold = async (file, deflection = null) => {
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
  const actualDeflection = deflection || 0.1;
  
  const formData = new FormData();
  formData.append('file', file);
  formData.append('deflection', actualDeflection.toString());
  
  const response = await fetch(`${API_URL}/api/convert-manifold`, {
    method: 'POST',
    body: formData
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ details: 'Conversion failed' }));
    throw new Error(error.details || 'Conversion failed');
  }
  
  return await response.json();
};

/**
 * Reconstruct Manifold from serialized mesh data
 */
export const reconstructManifold = (manifoldData, Module) => {
  return new Promise(async (resolve, reject) => {
    try {
      console.log('[Import] Loading Manifold WASM...');
      const wasm = await Module();
      wasm.setup();
      
      console.log('[Import] Reconstructing Manifold from server data...');
      
      // Convert arrays back to typed arrays
      const vertProperties = new Float32Array(manifoldData.vertProperties);
      const triVerts = new Uint32Array(manifoldData.triVerts);
      
      const mesh = {
        numProp: manifoldData.numProp || 3,
        vertProperties: vertProperties,
        triVerts: triVerts
      };
      
      console.log('[Import] Mesh stats:', {
        vertices: vertProperties.length / 3,
        triangles: triVerts.length / 3,
        numProp: mesh.numProp
      });
      
      // Create Manifold from the mesh
      const manifold = new wasm.Manifold(mesh);
      
      const volume = manifold.volume();
      console.log(`[Import] ✓ Manifold reconstructed (volume: ${volume} mm³)`);
      
      if (Math.abs(volume - manifoldData.volume) > 0.01) {
        console.warn(`[Import] Volume mismatch: server=${manifoldData.volume}, client=${volume}`);
      }
      
      resolve(manifold);
      
    } catch (error) {
      console.error('[Import] Error reconstructing Manifold:', error);
      reject(error);
    }
  });
};

/**
 * Generate JavaScript code that returns the cached Manifold
 */
export const generateImportScript = (filename, cacheKey, volume) => {
  return `// Imported from STEP file: ${filename}
// Converted via OpenCASCADE: STEP → 3MF → Manifold
// Volume: ${volume.toFixed(2)} mm³
// 
// This model was imported and converted to a Manifold object.
// You can now use all Manifold operations on this object.

// Retrieve the imported Manifold from global scope
const result = window.__importedManifolds?.['${cacheKey}'];

if (!result) {
  throw new Error('Imported model not found. Please re-upload the STEP file.');
}

return result;`;
};

/**
 * Full import workflow: Upload STEP → Server converts → Reconstruct Manifold
 */
export const importStepFile = async (file, Module, deflection = null) => {
  const startTime = Date.now();
  console.log(`[Import] Starting import of ${file.name}...`);
  
  try {
    // 1. Send to server for conversion
    console.log('[Import] Uploading to server for conversion...');
    const response = await convertStepToManifold(file, deflection);
    
    if (!response.success) {
      throw new Error(response.details || 'Server conversion failed');
    }
    
    console.log(`[Import] Server conversion complete`);
    
    // 2. Cache the manifold data
    console.log('[Import] Caching manifold data...');
    await cacheManifoldData(file.name, response.data);
    
    // 3. Reconstruct Manifold from data
    console.log('[Import] Reconstructing Manifold...');
    const manifold = await reconstructManifold(response.data, Module);
    
    // 4. Store in global scope for script access
    if (!window.__importedManifolds) {
      window.__importedManifolds = {};
    }
    const cacheKey = file.name;
    window.__importedManifolds[cacheKey] = manifold;
    
    // 5. Generate script
    const script = generateImportScript(file.name, cacheKey, response.data.volume);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Import] ✓ Import complete in ${duration}s`);
    
    return {
      script,
      manifold,
      filename: file.name,
      cacheKey,
      volume: response.data.volume
    };
  } catch (error) {
    console.error('[Import] Import failed:', error);
    throw error;
  }
};

/**
 * Load a cached model (if available)
 */
export const loadCachedModel = async (filename, Module) => {
  try {
    const data = await getCachedManifoldData(filename);
    if (!data) {
      return null;
    }
    
    const manifold = await reconstructManifold(data, Module);
    
    if (!window.__importedManifolds) {
      window.__importedManifolds = {};
    }
    window.__importedManifolds[filename] = manifold;
    
    return {
      script: generateImportScript(filename, filename, data.volume),
      manifold,
      filename,
      cacheKey: filename,
      volume: data.volume
    };
  } catch (error) {
    console.error('[Cache] Error loading cached model:', error);
    return null;
  }
};