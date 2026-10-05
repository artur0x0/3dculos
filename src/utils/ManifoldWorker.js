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
        sentAt: performance.now(),
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
          memoryLimitMB,
          nonce: options.nonce ?? null,
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
   * Keep the last execute() solid as the game-mode ghost target.
   * Must be called immediately after executing the puzzle target script,
   * before the player's attempt overwrites cachedManifold.
   */
  async storeGameTarget(options = {}) {
    if (!this.isReady) throw new Error('ManifoldWorker not initialized');
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`storeGameTarget timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pendingRequests.set(requestId, {
        resolve: (r) => { clearTimeout(timeoutId); resolve(r); },
        reject: (e) => { clearTimeout(timeoutId); reject(e); },
      });
      this.worker.postMessage({ type: 'storeGameTarget', id: requestId, payload: {} });
    });
  }

  /**
   * Compare the last execute() solid (attempt) against the stored ghost.
   * @param {Object} [opts]
   * @param {number} [opts.relEps]
   * @param {number} [opts.volFloor]
   * @param {*} [opts.nonce] - Must match the execute nonce that produced the on-screen solid
   */
  async compareGameMatch(opts = {}, options = {}) {
    if (!this.isReady) throw new Error('ManifoldWorker not initialized');
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`compareGameMatch timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pendingRequests.set(requestId, {
        resolve: (r) => { clearTimeout(timeoutId); resolve(r); },
        reject: (e) => { clearTimeout(timeoutId); reject(e); },
      });
      this.worker.postMessage({
        type: 'compareGameMatch',
        id: requestId,
        payload: { relEps: opts.relEps, volFloor: opts.volFloor, nonce: opts.nonce },
      });
    });
  }

  /** Drop the worker's cached solid from the last run (viewport-clearing run). */
  async clearResult(options = {}) {
    if (!this.isReady) throw new Error('ManifoldWorker not initialized');
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`clearResult timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pendingRequests.set(requestId, {
        resolve: (r) => { clearTimeout(timeoutId); resolve(r); },
        reject: (e) => { clearTimeout(timeoutId); reject(e); },
      });
      this.worker.postMessage({ type: 'clearResult', id: requestId, payload: {} });
    });
  }

  async clearGameTarget(options = {}) {
    if (!this.isReady) throw new Error('ManifoldWorker not initialized');
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`clearGameTarget timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pendingRequests.set(requestId, {
        resolve: (r) => { clearTimeout(timeoutId); resolve(r); },
        reject: (e) => { clearTimeout(timeoutId); reject(e); },
      });
      this.worker.postMessage({ type: 'clearGameTarget', id: requestId, payload: {} });
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
   * ── Stage verification protocol (dev tooling; pairs with the worker's
   * stageReference... / stageVerify cases). The staging environment (bundled
   * built/manifold.wasm) is the single kernel-truth source for the pilot:
   * push reference solids, fetch/verify against them here, never in a
   * divergent out-of-process copy.
   */
  async stageReferenceLoad(filename, { objString, meshData, tolerance } = {}, options = {}) {
    if (!this.isReady) throw new Error('ManifoldWorker not initialized');
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`stageReferenceLoad timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pendingRequests.set(requestId, {
        resolve: (r) => { clearTimeout(timeoutId); resolve(r); },
        reject: (e) => { clearTimeout(timeoutId); reject(e); },
      });
      this.worker.postMessage({
        type: 'stageReferenceLoad', id: requestId,
        payload: { filename, objString, meshData, tolerance },
      });
    });
  }

  async stageReferenceList() {
    if (!this.isReady) throw new Error('ManifoldWorker not initialized');
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      this.pendingRequests.set(requestId, { resolve, reject });
      this.worker.postMessage({ type: 'stageReferenceList', id: requestId, payload: {} });
    });
  }

  async stageReferenceClear() {
    if (!this.isReady) throw new Error('ManifoldWorker not initialized');
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      this.pendingRequests.set(requestId, { resolve, reject });
      this.worker.postMessage({ type: 'stageReferenceClear', id: requestId, payload: {} });
    });
  }

  async stageVerify(reference, opts = {}, options = {}) {
    if (!this.isReady) throw new Error('ManifoldWorker not initialized');
    const timeoutMs = options.timeoutMs || Math.max(this.config.timeoutMs, 120000);
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`stageVerify timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pendingRequests.set(requestId, {
        resolve: (r) => { clearTimeout(timeoutId); resolve(r); },
        reject: (e) => { clearTimeout(timeoutId); reject(e); },
      });
      this.worker.postMessage({
        type: 'stageVerify', id: requestId,
        payload: { reference, passRel: opts.passRel, volGate: opts.volGate,
                   candidateMesh: opts.candidateMesh, tolerance: opts.tolerance },
      });
    });
  }

  async stageGetLastMesh() {
    if (!this.isReady) throw new Error('ManifoldWorker not initialized');
    const timeoutMs = this.config.timeoutMs;
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`stageGetLastMesh timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pendingRequests.set(requestId, {
        resolve: (r) => { clearTimeout(timeoutId); resolve(r); },
        reject: (e) => { clearTimeout(timeoutId); reject(e); },
      });
      this.worker.postMessage({ type: 'stageGetLastMesh', id: requestId, payload: {} });
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
   * Split a clone of the cached solid for the Pieces preview.
   * Does not replace the cached manifold and does not write the script.
   *
   * @param {object} plane - Face `{ center, normal, offset? }` or `{ normal, originOffset }`
   * @param {{ at: number[] }[]} bodies - Bodies to cut. Omit to cut every body.
   * @returns {Promise<{ pieces: object[] }>}
   */
  /** One request/response round trip. */
  _request(type, payload, options = {}) {
    if (!this.isReady) {
      return Promise.reject(new Error('ManifoldWorker not initialized'));
    }
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`${type} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });
      this.worker.postMessage({ type, id: requestId, payload });
    });
  }

  /**
   * Which parts a subtract cutter overlaps. The cutter script runs on the
   * worker without replacing the cached solid.
   */
  async probeOverlap(cutterScript, parts, options = {}) {
    return this._request('probeOverlap', { cutterScript, parts }, options);
  }

  async previewBoolean(op, bodies, options = {}) {
    if (!this.isReady) {
      throw new Error('ManifoldWorker not initialized');
    }
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`previewBoolean timed out after ${timeoutMs / 1000}s`));
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
        type: 'previewBoolean',
        id: requestId,
        payload: {
          op,
          bodies,
          tools: Array.isArray(options.tools) ? options.tools : undefined,
          targetScript: typeof options.targetScript === 'string' ? options.targetScript : undefined,
        }
      });
    });
  }

  async previewCut(plane, bodies, options = {}) {
    if (!this.isReady) {
      throw new Error('ManifoldWorker not initialized');
    }
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`previewCut timed out after ${timeoutMs / 1000}s`));
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
        type: 'previewCut',
        id: requestId,
        payload: { plane, bodies }
      });
    });
  }

  /**
   * Offset a clone of the cached solid for the Move Face preview.
   * Does not replace the cached manifold and does not write the script.
   *
   * @param {{ center: number[], normal: number[] }[]} faces
   * @param {number} distance
   * @param {boolean} [flip]
   * @returns {Promise<{ mesh: object }>}
   */
  async previewMoveFace(faces, distance, flip = false, options = {}) {
    if (!this.isReady) {
      throw new Error('ManifoldWorker not initialized');
    }
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`previewMoveFace timed out after ${timeoutMs / 1000}s`));
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
        type: 'previewMoveFace',
        id: requestId,
        payload: { faces, distance, flip }
      });
    });
  }

  /**
   * Block pop preview. Builds the new solid (size + pose) without reading
   * or replacing the cached part, and without writing the script.
   *
   * @param {string} id palette id: cube, roundedBox, cylinder, sphere, tube, hexPrism
   * @param {object} params sheet values
   * @returns {Promise<{ mesh: object, volume: number, boundingBox: object, combine: string }>}
   */
  async previewBlock(id, params, options = {}) {
    if (!this.isReady) {
      throw new Error('ManifoldWorker not initialized');
    }
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`previewBlock timed out after ${timeoutMs / 1000}s`));
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
        type: 'previewBlock',
        id: requestId,
        payload: { id, params }
      });
    });
  }

  /**
   * Heal a clone of the cached solid for the Delete Face preview.
   * Does not replace the cached manifold and does not write the script.
   *
   * @param {{ center: number[], normal: number[] }[]} faces
   * @returns {Promise<{ mesh: object }>}
   */
  async previewDeleteFace(faces, options = {}) {
    if (!this.isReady) {
      throw new Error('ManifoldWorker not initialized');
    }
    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`previewDeleteFace timed out after ${timeoutMs / 1000}s`));
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
        type: 'previewDeleteFace',
        id: requestId,
        payload: { faces }
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
          if (payload && payload.timing && request.sentAt != null) {
            const roundTripMs = performance.now() - request.sentAt;
            const execMs = Number(payload.timing.execMs) || 0;
            const serializeMs = Number(payload.timing.serializeMs) || 0;
            payload.timing.roundTripMs = roundTripMs;
            payload.timing.transferMs = Math.max(0, roundTripMs - execMs - serializeMs);
          }
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
   * Retain the last executeScript() solid as the game ghost target.
   */
  async storeGameTarget() {
    if (!this.worker || !this.worker.isReady) {
      throw new Error('ManifoldContext not initialized');
    }
    return await this.worker.storeGameTarget();
  }

  /**
   * Boolean-difference the last executeScript() attempt vs the stored ghost.
   */
  async compareGameMatch(opts = {}) {
    if (!this.worker || !this.worker.isReady) {
      throw new Error('ManifoldContext not initialized');
    }
    return await this.worker.compareGameMatch(opts);
  }

  /**
   * Forget the last execution everywhere: context cache + worker-side manifold.
   * A run that clears the viewport (empty / comment-only / plane-only script) must
   * leave nothing behind for cross-section, model info, quoting, game compare or
   * the stage hooks to serve as "the current part".
   */
  async clearResult() {
    this.lastResult = null;
    if (!this.worker || !this.worker.isReady) return { ok: true };
    return await this.worker.clearResult();
  }

  async clearGameTarget() {
    if (!this.worker || !this.worker.isReady) {
      throw new Error('ManifoldContext not initialized');
    }
    return await this.worker.clearGameTarget();
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
   * Pieces preview. Runs the real cut on a clone of the last solid and
   * returns each piece mesh. The cached solid is left as it was.
   */
  async previewBoolean({ op, bodies, tools, targetScript } = {}) {
    if (!this.worker || !this.worker.isReady) {
      throw new Error('ManifoldContext not initialized');
    }
    return await this.worker.previewBoolean(op, bodies, { tools, targetScript });
  }

  /**
   * Cross-part subtract: which part meshes the frozen cutter overlaps.
   * @param {{ cutterScript: string, parts: { id: string, mesh: object, offset: number[] }[] }} args
   */
  async probeOverlap({ cutterScript, parts } = {}) {
    if (!this.worker || !this.worker.isReady) {
      throw new Error('ManifoldContext not initialized');
    }
    return await this.worker.probeOverlap(cutterScript, parts);
  }

  async previewCut({ plane, bodies } = {}) {
    if (!this.worker || !this.worker.isReady) {
      throw new Error('ManifoldContext not initialized');
    }
    return await this.worker.previewCut(plane, bodies);
  }

  /**
   * Move Face preview. Runs moveFace on a clone of the last solid.
   * The cached solid is left as it was.
   */
  async previewMoveFace({ faces, distance, flip } = {}) {
    if (!this.worker || !this.worker.isReady) {
      throw new Error('ManifoldContext not initialized');
    }
    return await this.worker.previewMoveFace(faces, distance, !!flip);
  }

  /**
   * Delete Face preview. Runs deleteFace on a clone of the last solid.
   * The cached solid is left as it was.
   */
  async previewDeleteFace({ faces } = {}) {
    if (!this.worker || !this.worker.isReady) {
      throw new Error('ManifoldContext not initialized');
    }
    return await this.worker.previewDeleteFace(faces);
  }

  /**
   * Block pop preview. The cached solid is left as it was.
   */
  async previewBlock({ id, params } = {}) {
    if (!this.worker || !this.worker.isReady) {
      throw new Error('ManifoldContext not initialized');
    }
    return await this.worker.previewBlock(id, params);
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

// Dev/automation hook: lets headless review tooling (harness/stage_shot.mjs) drive the
// REAL worker path without a human clicking Run. Gated so production bundles are unaffected.
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  window.__MANIFOLD_CONTEXT__ = manifoldContext;
}

export { ManifoldWorker, ManifoldContext, manifoldContext };
export default manifoldContext;
