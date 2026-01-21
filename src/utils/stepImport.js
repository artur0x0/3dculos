// utils/stepImport.js
const DB_NAME = 'SurfDB';
const DB_VERSION = 1;
const STORE_NAME = 'models';

/**
 * Cache limits
 */
const CACHE_LIMITS = {
  maxCount: 128,              // Max number of models in memory
  maxMemoryMB: 1024,          // Max estimated memory usage
  bytesPerVertex: 12,        // 3 floats × 4 bytes
  bytesPerTriangle: 12,      // 3 uint32 indices × 4 bytes
};

/**
 * LRU Cache for imported manifolds with memory estimation
 */
class ManifoldCache {
  constructor(maxCount = CACHE_LIMITS.maxCount, maxMemoryMB = CACHE_LIMITS.maxMemoryMB) {
    this.maxCount = maxCount;
    this.maxMemoryBytes = maxMemoryMB * 1024 * 1024;
    this.cache = new Map(); // filename -> { manifold, accessTime, estimatedBytes }
    this.totalBytes = 0;
  }
  
  /**
   * Estimate memory usage of a manifold based on mesh data
   */
  estimateBytes(manifold) {
    try {
      const mesh = manifold.getMesh();
      const vertexBytes = mesh.vertProperties.length * 4; // Float32
      const indexBytes = mesh.triVerts.length * 4;        // Uint32
      const overhead = 1024; // Object overhead estimate
      return vertexBytes + indexBytes + overhead;
    } catch {
      return 50 * 1024; // Default 50KB if we can't measure
    }
  }
  
  /**
   * Get a model from cache, updating access time
   */
  get(filename) {
    const entry = this.cache.get(filename);
    if (entry) {
      entry.accessTime = Date.now();
      return entry.manifold;
    }
    return undefined;
  }
  
  /**
   * Check if model exists in cache
   */
  has(filename) {
    return this.cache.has(filename);
  }
  
  /**
   * Add a model to cache, evicting LRU items if needed
   */
  set(filename, manifold) {
    // If already exists, update it
    if (this.cache.has(filename)) {
      const existing = this.cache.get(filename);
      this.totalBytes -= existing.estimatedBytes;
    }
    
    const estimatedBytes = this.estimateBytes(manifold);
    
    // Evict until we have room (by count)
    while (this.cache.size >= this.maxCount) {
      this.evictLRU();
    }
    
    // Evict until we have room (by memory)
    while (this.totalBytes + estimatedBytes > this.maxMemoryBytes && this.cache.size > 0) {
      this.evictLRU();
    }
    
    // Add to cache
    this.cache.set(filename, {
      manifold,
      accessTime: Date.now(),
      estimatedBytes
    });
    this.totalBytes += estimatedBytes;
    
    console.log(`[Cache] Added ${filename} (${(estimatedBytes / 1024).toFixed(1)}KB). ` +
                `Total: ${this.cache.size} models, ${(this.totalBytes / 1024 / 1024).toFixed(2)}MB`);
  }
  
  /**
   * Evict the least recently used item
   */
  evictLRU() {
    let oldestKey = null;
    let oldestTime = Infinity;
    
    for (const [key, entry] of this.cache) {
      if (entry.accessTime < oldestTime) {
        oldestTime = entry.accessTime;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      const entry = this.cache.get(oldestKey);
      this.totalBytes -= entry.estimatedBytes;
      this.cache.delete(oldestKey);
      console.log(`[Cache] Evicted LRU: ${oldestKey} (${(entry.estimatedBytes / 1024).toFixed(1)}KB)`);
    }
  }
  
  /**
   * Clear entire cache
   */
  clear() {
    this.cache.clear();
    this.totalBytes = 0;
    console.log('[Cache] Cleared all cached models');
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    return {
      count: this.cache.size,
      maxCount: this.maxCount,
      memoryMB: this.totalBytes / 1024 / 1024,
      maxMemoryMB: this.maxMemoryBytes / 1024 / 1024,
      filenames: [...this.cache.keys()]
    };
  }
}

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
    
    await new Promise((resolve, reject) => {
      const request = store.put({
        filename,
        data,
        timestamp: Date.now()
      });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
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
 */
export const convertStepToManifold = async (file, deflection = null) => {
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
  const actualDeflection = deflection || 0.1;
  
  const formData = new FormData();
  formData.append('file', file);
  formData.append('deflection', actualDeflection.toString());
  
  const response = await fetch(`${API_URL}/api/convert/step`, {
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
export const reconstructManifold = (manifoldData, wasm = null) => {
  console.log('[Import] Reconstructing Manifold from server data...');
  
  const manifoldWasm = wasm || window.Manifold;
  if (!manifoldWasm) {
    throw new Error('Manifold WASM not loaded. Please wait for initialization.');
  }
  
  const { Manifold } = manifoldWasm;
  
  const vertProperties = new Float32Array(manifoldData.vertProperties);
  const triVerts = new Uint32Array(manifoldData.triVerts);
  
  const mesh = {
    numProp: manifoldData.numProp || 3,
    vertProperties,
    triVerts
  };
  
  console.log('[Import] Mesh stats:', {
    vertices: vertProperties.length / 3,
    triangles: triVerts.length / 3,
    numProp: mesh.numProp
  });
  
  const manifold = new Manifold(mesh);
  
  const volume = manifold.volume();
  console.log(`[Import] ✓ Manifold reconstructed (volume: ${volume} mm³)`);
  
  if (manifoldData.volume && Math.abs(volume - manifoldData.volume) > 0.01) {
    console.warn(`[Import] Volume mismatch: server=${manifoldData.volume}, client=${volume}`);
  }
  
  return manifold;
};

/**
 * Store a manifold in the in-memory cache
 */
export const storeImportedModel = (filename, manifold) => {
  if (!window.__importedManifolds) {
    window.__importedManifolds = {};
  }
  window.__importedManifolds[filename] = manifold
};

/**
 * Check if a model is in memory
 */
export const hasImportedModel = (filename) => {
  if (window.__importedManifolds[filename]) return true;
  else return false;
};

/**
 * Parse a script to find imported model filenames.
 * Looks for: window.__importedManifolds['${filename}']
 */
export const parseImportedModels = (script) => {
  const pattern = /window\.__importedManifolds\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
  const filenames = [];
  let match;
  while ((match = pattern.exec(script)) !== null) {
    filenames.push(match[1]);
  }
  return [...new Set(filenames)];
};

/**
 * Generate JavaScript code that retrieves the imported Manifold.
 */
export const generateImportScript = (filename, volume) => {
  return `// Imported from STEP file: ${filename}
// Volume: ${volume.toFixed(2)} mm³
// 
// This model was imported and converted to a Manifold object.
// You can now use all Manifold operations on this object.

const importedModel = window.__importedManifolds['${filename}'];

return importedModel;`;
};

/**
 * Full import workflow: Upload STEP → Server converts → Reconstruct Manifold
 */
export const importStepFile = async (file, deflection = null) => {
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
    
    // 2. Cache the manifold data in IndexedDB
    console.log('[Import] Caching manifold data...');
    await cacheManifoldData(file.name, response.data);
    
    // 3. Reconstruct Manifold from data
    console.log('[Import] Reconstructing Manifold...');
    const manifold = reconstructManifold(response.data);
    
    // 4. Store in memory cache
    const filename = file.name;
    storeImportedModel(filename, manifold);
    
    // 5. Generate script
    const script = generateImportScript(filename, response.data.volume);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Import] ✓ Import complete in ${duration}s`);
    
    return {
      script,
      manifold,
      filename,
      volume: response.data.volume
    };
  } catch (error) {
    console.error('[Import] Import failed:', error);
    throw error;
  }
};

/**
 * Load a cached model from IndexedDB
 */
export const loadCachedModel = async (filename) => {
  console.log(`[stepImport] Loading cached model: ${filename}`);
  try {
    const data = await getCachedManifoldData(filename);
    if (!data) {
      console.warn(`[stepImport] No cached data found for: ${filename}`);
      return null;
    }

    if (!window.Manifold) {
      console.error("[stepImport] WASM not available during cached STEP file retrieval");
      return null;
    }
    
    console.log("[stepImport] Cached model data found, reconstructing...");
    const manifold = reconstructManifold(data);
    
    // Store in memory for future access
    storeImportedModel(filename, manifold);
    
    return {
      script: generateImportScript(filename, data.volume),
      manifold,
      filename,
      volume: data.volume
    };
  } catch (error) {
    console.error('[Cache] Error loading cached model:', error);
    return null;
  }
};
