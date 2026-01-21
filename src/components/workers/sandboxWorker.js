// workers/sandboxWorker.js
// This worker executes user scripts in an isolated context with restricted globals

/**
 * List of globals to block/remove in the worker context
 */
const BLOCKED_GLOBALS = [
  // Network
  'fetch',
  'XMLHttpRequest', 
  'WebSocket',
  'EventSource',
  
  // Storage
  'indexedDB',
  'caches',
  
  // Workers (prevent spawning nested workers)
  'Worker',
  'SharedWorker',
  
  // Messaging that could leak data
  'BroadcastChannel',
  
  // Import (dynamic)
  'importScripts', // Keep this blocked but we'll load Manifold before blocking
];

/**
 * Globals to make read-only proxies (allow reading but not as escape vectors)
 */
const READONLY_GLOBALS = [
  'navigator',
  'location',
  'performance',
];

let manifoldModule = null;
let isInitialized = false;

/**
 * Load and initialize Manifold WASM
 */
const initializeManifold = async (wasmUrl) => {
  if (isInitialized) return;
  
  try {
    // Import the Manifold module
    // We use importScripts before blocking it
    const Module = await import(wasmUrl);
    manifoldModule = await Module.default();
    manifoldModule.setup();
    
    isInitialized = true;
    console.log('[SandboxWorker] Manifold initialized');
  } catch (error) {
    console.error('[SandboxWorker] Failed to initialize Manifold:', error);
    throw error;
  }
};

/**
 * Block dangerous globals
 */
const lockdownGlobals = () => {
  // Block dangerous globals by replacing with functions that throw
  for (const name of BLOCKED_GLOBALS) {
    if (name in self) {
      Object.defineProperty(self, name, {
        get() {
          throw new Error(`Access to '${name}' is not allowed in scripts`);
        },
        configurable: false
      });
    }
  }
  
  // Make certain globals read-only and return limited info
  for (const name of READONLY_GLOBALS) {
    const original = self[name];
    if (original) {
      Object.defineProperty(self, name, {
        get() {
          // Return a frozen proxy that only allows safe operations
          return Object.freeze({ ...original });
        },
        configurable: false
      });
    }
  }
  
  console.log('[SandboxWorker] Globals locked down');
};

/**
 * Reconstruct a Manifold from mesh data
 */
const reconstructManifold = (meshData) => {
  if (!manifoldModule) {
    throw new Error('Manifold not initialized');
  }
  
  const { Manifold } = manifoldModule;
  
  const vertProperties = new Float32Array(meshData.vertProperties);
  const triVerts = new Uint32Array(meshData.triVerts);
  
  const mesh = {
    numProp: meshData.numProp || 3,
    vertProperties,
    triVerts
  };
  
  return new Manifold(mesh);
};

/**
 * Execute the user script with the Manifold API
 */
const executeScript = (script, importedModels) => {
  if (!manifoldModule) {
    throw new Error('Manifold not initialized');
  }
  
  // Set up __importedManifolds with reconstructed Manifolds
  const importedManifolds = {};
  for (const [filename, meshData] of Object.entries(importedModels || {})) {
    importedManifolds[filename] = reconstructManifold(meshData);
  }
  
  // Create a limited window-like object for imports only
  const limitedWindow = {
    __importedManifolds: importedManifolds
  };
  
  // Build the execution scope with Manifold API
  const scope = {
    ...manifoldModule,
    window: limitedWindow,  // Limited window object
  };
  
  const scopeKeys = Object.keys(scope);
  const scopeValues = Object.values(scope);
  
  // Create and execute the function
  const fn = new Function(...scopeKeys, script);
  return fn(...scopeValues);
};

/**
 * Serialize a Manifold result to mesh data for transfer
 */
const serializeResult = (manifold) => {
  if (!manifold || typeof manifold.getMesh !== 'function') {
    throw new Error('Script must return a Manifold object');
  }
  
  const mesh = manifold.getMesh();
  
  return {
    numProp: mesh.numProp,
    vertProperties: Array.from(mesh.vertProperties),
    triVerts: Array.from(mesh.triVerts),
    numRun: mesh.numRun,
    runIndex: Array.from(mesh.runIndex),
    runOriginalID: Array.from(mesh.runOriginalID),
    faceID: mesh.faceID ? Array.from(mesh.faceID) : null,
  };
};

/**
 * Memory monitoring - check if we're using too much memory
 */
const checkMemoryUsage = (limitMB) => {
  if (performance.memory) {
    const usedMB = performance.memory.usedJSHeapSize / (1024 * 1024);
    if (usedMB > limitMB) {
      throw new Error(`Memory limit exceeded: ${usedMB.toFixed(1)}MB > ${limitMB}MB`);
    }
    return usedMB;
  }
  return null; // Can't measure in this browser
};

/**
 * Message handler
 */
self.onmessage = async (event) => {
  const { type, payload } = event.data;
  
  try {
    switch (type) {
      case 'init': {
        const { wasmUrl } = payload;
        await initializeManifold(wasmUrl);
        lockdownGlobals();
        self.postMessage({ type: 'ready' });
        break;
      }
      
      case 'execute': {
        if (!isInitialized) {
          throw new Error('Worker not initialized');
        }
        
        const { script, importedModels, memoryLimitMB } = payload;
        
        // Check memory before execution
        checkMemoryUsage(memoryLimitMB || 512);
        
        // Execute the script
        const result = executeScript(script, importedModels);
        
        // Check memory after execution
        const memoryUsed = checkMemoryUsage(memoryLimitMB || 512);
        
        // Serialize result for transfer
        const meshData = serializeResult(result);
        
        self.postMessage({ 
          type: 'result', 
          payload: {
            mesh: meshData,
            memoryUsedMB: memoryUsed
          }
        });
        break;
      }
      
      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    self.postMessage({ 
      type: 'error', 
      payload: {
        message: error.message,
        stack: error.stack
      }
    });
  }
};

// Signal that the worker is loaded
self.postMessage({ type: 'loaded' });