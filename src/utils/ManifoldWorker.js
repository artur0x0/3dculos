// utils/ManifoldWorker.js
// Wrapper class that manages the sandbox worker and exposes a clean API

/**
 * ManifoldWorker provides a Promise-based API for executing Manifold scripts
 * in an isolated Web Worker environment.
 * 
 * Usage:
 *   const manifold = new ManifoldWorker();
 *   await manifold.init();
 *   const meshData = await manifold.execute(script);
 */
import SandboxWorker from '../workers/sandboxWorker.js?worker'

class ManifoldWorker {
  constructor() {
    this.worker = null;
    this.isReady = false;
    this.pendingRequests = new Map();
    this.requestIdCounter = 0;
    
    this.config = {
      timeoutMs: 30000,
      memoryLimitMB: 512,
    };
    
    this.onError = null;
  }
  
  async init() {
    if (this.isReady) {
      console.log('[ManifoldWorker] Already initialized');
      return;
    }
    
    return new Promise((resolve, reject) => {
      try {
        // Create worker using Vite's import
        this.worker = new SandboxWorker();
        
        this.worker.onmessage = (event) => this._handleMessage(event);
        
        this.worker.onerror = (error) => {
          console.error('[ManifoldWorker] Worker error:', error);
          reject(new Error(`Worker error: ${error.message}`));
        };
        
        // Wait for 'loaded' signal, then send init
        const initHandler = (event) => {
          if (event.data.type === 'loaded') {
            console.log('[ManifoldWorker] Worker loaded, sending init...');
            
            const initId = this._generateRequestId();
            this.pendingRequests.set(initId, { resolve, reject });
            
            // No payload needed - worker imports WASM directly
            this.worker.postMessage({
              type: 'init',
              id: initId,
              payload: {}
            });
          }
        };
        
        this.worker.addEventListener('message', initHandler);
        
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * Execute a Manifold script
   * @param {string} script - The script to execute
   * @param {Object} options - Execution options
   * @param {Object} options.importedModels - Pre-serialized imported models
   * @param {number} options.timeoutMs - Timeout in milliseconds
   * @param {number} options.memoryLimitMB - Memory limit in MB
   * @returns {Promise<Object>} - The mesh data result
   */
  async execute(script, options = {}) {
    if (!this.isReady) {
      throw new Error('ManifoldWorker not initialized. Call init() first.');
    }
    
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    const memoryLimitMB = options.memoryLimitMB || this.config.memoryLimitMB;
    const importedModels = options.importedModels || {};
    
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      
      // Set up timeout
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Script execution timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      
      // Store request
      this.pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      });
      
      // Send execute message
      this.worker.postMessage({
        type: 'execute',
        id: requestId,
        payload: {
          script,
          importedModels,
          memoryLimitMB
        }
      });
    });
  }

  /**
   * Get model information (volume, surface area, bounding box) from cached manifold
   * 
   * @param {Object} [options] - Options
   * @param {number} [options.timeoutMs] - Timeout in milliseconds
   * @returns {Promise<Object>} Model info containing:
   *   - volume: Volume in mm³
   *   - surfaceArea: Surface area in mm²
   *   - boundingBox: { min: [x,y,z], max: [x,y,z] }
   * @throws {Error} If no manifold is cached
   */
  async getModelInfo(options = {}) {
    if (!this.isReady) {
      throw new Error('ManifoldWorker not initialized');
    }
    
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`getModelInfo timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      
      this.pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      });
      
      this.worker.postMessage({
        type: 'getModelInfo',
        id: requestId,
        payload: {}
      });
    });
  }

  /**
   * Import OBJ string and create Manifold
   * This is the preferred import method - STL and 3MF should convert to OBJ first
   * 
   * @param {string} objString - OBJ format string
   * @param {string} filename - Filename for caching
   * @param {Object} [options] - Options
   * @returns {Promise<{mesh: Object, volume: number, boundingBox: Object}>}
   */
  async importOBJ(objString, filename, options = {}) {
    if (!this.isReady) {
      throw new Error('ManifoldWorker not initialized');
    }
    
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`importOBJ timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      
      this.pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      });
      
      this.worker.postMessage({
        type: 'importOBJ',
        id: requestId,
        payload: { objString, filename }
      });
    });
  }
  
  /**
   * Get list of available helper functions
   * @returns {Promise<string[]>}
   */
  async getHelperList() {
    if (!this.isReady) {
      throw new Error('ManifoldWorker not initialized');
    }
    
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      
      this.pendingRequests.set(requestId, { resolve, reject });
      
      this.worker.postMessage({
        type: 'getHelperList',
        id: requestId
      });
    });
  }

  /**
   * Cross section a cached manifold
   * 
   * This operation uses the manifold cached from the last execute() call
   * and trims it by the specified plane, returning the portion on the 
   * negative side of the plane (opposite to the normal direction).
   * 
   * @param {number[]} normal - Unit normal vector of the cutting plane [x, y, z]
   * @param {number} originOffset - Distance from origin along the normal direction.
   *                                Positive values move the plane in the normal direction.
   * @param {Object} [options] - Optional execution options
   * @param {number} [options.timeoutMs] - Timeout in milliseconds (default: from config)
   * @returns {Promise<Object>} Result object containing:
   *   - mesh: Serialized mesh data of the trimmed manifold
   */
  async trimByPlane(normal, originOffset, options = {}) {
    if (!this.isReady) {
      throw new Error('ManifoldWorker not initialized');
    }
    
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`trimByPlane timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      
      this.pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      });
      
      this.worker.postMessage({
        type: 'trimByPlane',
        id: requestId,
        payload: { normal, originOffset }
      });
    });
  }
  
  /**
   * Terminate the worker
   */
  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.isReady = false;
      this.pendingRequests.clear();
      console.log('[ManifoldWorker] Terminated');
    }
  }
  
  /**
   * Restart the worker (terminate and reinitialize)
   * @returns {Promise<void>}
   */
  async restart() {
    this.terminate();
    await this.init();
  }
  
  /**
   * Configure the worker
   * @param {Object} config - Configuration options
   */
  configure(config) {
    this.config = { ...this.config, ...config };
  }
  
  // ========== Private Methods ==========
  
  _generateRequestId() {
    return `req_${++this.requestIdCounter}_${Date.now()}`;
  }
  
  _handleMessage(event) {
    const { type, id, payload } = event.data;
    
    switch (type) {
      case 'ready': {
        // Handled in init()
        const request = this.pendingRequests.get(id);
        if (request) {
          this.pendingRequests.delete(id);
          this.isReady = true;
          request.resolve();
        }
        break;
      }
      
      case 'result': {
        const request = this.pendingRequests.get(id);
        if (request) {
          this.pendingRequests.delete(id);
          request.resolve(payload);
        }
        break;
      }
      
      case 'helperList': {
        const request = this.pendingRequests.get(id);
        if (request) {
          this.pendingRequests.delete(id);
          request.resolve(payload);
        }
        break;
      }
      
      case 'error': {
        const request = this.pendingRequests.get(id);
        if (request) {
          this.pendingRequests.delete(id);
          const error = new Error(payload.message);
          error.stack = payload.stack;
          request.reject(error);
        }
        
        // Also call global error handler if set
        if (this.onError) {
          this.onError(payload);
        }
        break;
      }
      
      case 'loaded': {
        // Worker script loaded (handled in init())
        break;
      }
      
      default:
        console.warn('[ManifoldWorker] Unknown message type:', type);
    }
  }
}

/**
 * ManifoldContext - A React-friendly wrapper that also handles mesh rendering
 * This can be used as a global singleton or per-viewport instance
 */
class ManifoldContext {
  constructor() {
    this.worker = null;
    this.cachedManifolds = new Map();  // For cross-section operations
    this.meshCache = new Map();        // For imported models
  }
  
  /**
   * Initialize the context
   */
  async init() {
    this.worker = new ManifoldWorker();
    await this.worker.init();
    
    // Expose on window for backward compatibility
    window.ManifoldContext = this;
    
    console.log('[ManifoldContext] Initialized');
  }
  
  /**
   * Execute a script and return mesh data
   * @param {string} script - The script to execute
   * @param {Object} options - Execution options
   * @returns {Promise<Object>} - { mesh, memoryUsedMB }
   */
  async executeScript(script, options = {}) {
    if (!this.worker || !this.worker.isReady) {
      throw new Error('ManifoldContext not initialized');
    }
    
    // Gather imported models from cache
    const importedModels = {};
    for (const [filename, meshData] of this.meshCache) {
      importedModels[filename] = meshData;
    }
    
    const result = await this.worker.execute(script, {
      ...options,
      importedModels
    });
    
    // Cache the full result for quoting/downloads
    this.lastResult = result;
    
    return result;
  }

  /**
   * Get model information from the cached manifold
   * 
   * @returns {Promise<Object>} Model info { volume, surfaceArea, boundingBox }
   */
  async getModelInfo() {
    if (!this.worker || !this.worker.isReady) {
      throw new Error('ManifoldContext not initialized');
    }
    
    return await this.worker.getModelInfo();
  }

  /**
   * Import OBJ string and create Manifold
   * @param {string} objString - OBJ format string
   * @param {string} filename - Filename for caching
   * @returns {Promise<{mesh: Object, volume: number, boundingBox: Object}>}
   */
  async importOBJ(objString, filename) {
    if (!this.worker || !this.worker.isReady) {
      throw new Error('ManifoldContext not initialized');
    }
    
    return await this.worker.importOBJ(objString, filename);
  }

  /**
   * Get the last execution result (includes mesh, volume, boundingBox)
   * @returns {Object|null}
   */
  getLastResult() {
    return this.lastResult || null;
  }

  /**
   * Trim the cached manifold by a plane
   * 
   * Convenience wrapper for cross-section preview operations. Uses the 
   * manifold cached from the most recent executeScript() call.
   * 
   * @param {number[]} normal - Unit normal vector of the cutting plane [x, y, z].
   *                            The portion of the manifold on the negative side
   *                            (opposite to normal direction) is kept.
   * @param {number} originOffset - Signed distance from the origin to the plane
   *                                along the normal vector. Positive moves the
   *                                plane in the normal direction.
   * @returns {Promise<Object>} Result object containing:
   *   - mesh: Serialized mesh data with vertProperties, triVerts, etc.
   */
  async trimByPlane(normal, originOffset) {
    if (!this.worker || !this.worker.isReady) {
      throw new Error('ManifoldContext not initialized');
    }
    
    return await this.worker.trimByPlane(normal, originOffset);
  }
  
  /**
   * Cache an imported model for use in scripts
   * @param {string} filename - The filename key
   * @param {Object} meshData - The serialized mesh data
   */
  cacheImportedModel(filename, meshData) {
    this.meshCache.set(filename, meshData);
    console.log(`[ManifoldContext] Cached model: ${filename}`);
  }
  
  /**
   * Get a cached imported model
   * @param {string} filename - The filename key
   * @returns {Object|null} - The mesh data or null
   */
  getImportedModel(filename) {
    return this.meshCache.get(filename) || null;
  }

  /**
   * Clear all cached models
   */
  clearCache() {
    this.meshCache.clear();
    this.cachedManifolds.clear();
  }
  
  /**
   * Get list of helper functions available in scripts
   * @returns {Promise<string[]>}
   */
  async getHelperFunctions() {
    if (!this.worker) return [];
    return await this.worker.getHelperList();
  }
  
  /**
   * Check if initialized
   * @returns {boolean}
   */
  get isReady() {
    return this.worker?.isReady || false;
  }
  
  /**
   * Terminate the context
   */
  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.clearCache();
  }
}

// Create and export singleton instance
const manifoldContext = new ManifoldContext();

export { ManifoldWorker, ManifoldContext, manifoldContext };
export default manifoldContext;
