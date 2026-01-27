// components/Viewport.jsx
import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  PointLight,
  Mesh as ThreeMesh,
  MeshLambertMaterial,
  MeshNormalMaterial,
  MeshBasicMaterial,
  BufferGeometry,
  BufferAttribute,
  Raycaster,
  Vector2,
  Vector3,
  Triangle,
  LineSegments,
  EdgesGeometry,
  LineBasicMaterial
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import Toolbar from './Toolbar';
import CrossSectionPanel from './CrossSectionPanel';
import { X } from 'lucide-react';
import { downloadModelFromMesh, get3MFBase64FromMesh } from '../utils/exportModel';
import { parseImportedModels, loadCachedModel } from '../utils/importModel';
import { calculateQuote } from '../utils/quoting';
import { selectFaceByID } from '../utils/selectFace';
import { createCuttingPlaneWidget, updateCuttingPlaneWidget } from '../utils/cuttingPlaneWidget';
import { AxesHelper } from 'three';
import { calculateMeasurements } from '../utils/measurementTool';
import { validateScript, formatValidationErrors } from '../utils/scriptValidator';
import manifoldContext from '../utils/ManifoldWorker';

// Execution limits
const EXECUTION_LIMITS = {
  timeoutMs: 30000,      // 30 seconds max execution time
  memoryLimitMB: 512,    // 512 MB memory limit
};

const Viewport = forwardRef(({ 
  onAccount,
  currentScript, 
  onFaceSelected, 
  onOpen,
  onSave,
  onQuote,
  onUpload,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  currentFilename,
  isUploading
}, ref) => {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const resultRef = useRef(null);
  const raycasterRef = useRef(new Raycaster());
  const mouseRef = useRef(new Vector2());
  const highlightMeshRef = useRef(null);
  const cuttingPlaneWidgetRef = useRef(null);
  const axisHelperRef = useRef(null);
  const executionAbortRef = useRef(null);
  
  const [selectedFace, setSelectedFace] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionError, setExecutionError] = useState(null);
  const [downloadFormat, setDownloadFormat] = useState('3mf');
  const [isDownloading, setIsDownloading] = useState(false);
  
  // Cross-section state
  const [crossSectionEnabled, setCrossSectionEnabled] = useState(false);
  const [crossSectionPlane, setCrossSectionPlane] = useState({
    normal: [0, 0, 1],
    originOffset: 0,
    showPlane: true
  });
  const [modelBounds, setModelBounds] = useState(null);
  const [cachedMeshData, setCachedMeshData] = useState(null);
  
  // Measurement tool and axis helper state
  const [measurementEnabled, setMeasurementEnabled] = useState(false);
  const [measurementFaces, setMeasurementFaces] = useState({ first: null, second: null });
  const [axisHelperEnabled, setAxisHelperEnabled] = useState(false);

  useImperativeHandle(ref, () => ({
    executeScript,
    clearFaceSelection: () => {
      clearHighlight();
      setSelectedFace(null);
      onFaceSelected?.(null);
    },
    // Updated to use cached mesh when available
    export3MF: async () => {
      if (cachedMeshData?.vertProperties) {
        return get3MFBase64FromMesh(cachedMeshData);
      }
      throw new Error('No model available to export');
    },
    calculateQuote: async (options) => {
      return await calculateQuote(currentScript, options);
    },
    zoomToFit: handleZoomToFit,
    getCurrentMeshData: () => cachedMeshData
  }));

  // Clear face highlight
  const clearHighlight = useCallback(() => {
    if (highlightMeshRef.current) {
      if (Array.isArray(highlightMeshRef.current)) {
        highlightMeshRef.current.forEach(mesh => {
          sceneRef.current.remove(mesh);
          mesh.geometry?.dispose();
          mesh.material?.dispose();
        });
        highlightMeshRef.current = [];
      } else {
        sceneRef.current.remove(highlightMeshRef.current);
        highlightMeshRef.current.geometry?.dispose();
        highlightMeshRef.current.material?.dispose();
        highlightMeshRef.current = null;
      }
    }
  }, []);

  // Clear cutting plane widget
  const clearCuttingPlane = () => {
    if (cuttingPlaneWidgetRef.current && sceneRef.current) {
      sceneRef.current.remove(cuttingPlaneWidgetRef.current);
      cuttingPlaneWidgetRef.current.children.forEach(child => {
        child.geometry?.dispose();
        child.material?.dispose();
      });
      cuttingPlaneWidgetRef.current = null;
    }
  };

  // Handle cross-section toggle
  const handleCrossSectionToggle = async (enabled) => {
    if (enabled) {
      try {
        if (!manifoldContext.isReady || !currentScript) return;
        setCrossSectionEnabled(true);
      } catch (error) {
        console.error('[CrossSection] Failed to enable:', error);
      }
    } else {
      // Disable and restore original
      setCrossSectionEnabled(false);
      clearCuttingPlane();
    }
  };

  // Handle plane changes for cross-section preview
  const handlePlaneChange = async (plane) => {
    setCrossSectionPlane(plane);
    
    if (!crossSectionEnabled || !cachedMeshData) return;
    
    try {
      const normal = new Vector3(...plane.normal).normalize();
      const normalArray = [normal.x, normal.y, normal.z];
      
      // Call worker to trim the cached manifold
      const { mesh: trimmedMesh } = await manifoldContext.trimByPlane(
        normalArray, 
        plane.originOffset
      );
      
      // Render the trimmed result
      renderMeshData(trimmedMesh);
      
      // Update cutting plane widget visibility
      if (plane.showPlane) {
        if (cuttingPlaneWidgetRef.current) {
          updateCuttingPlaneWidget(cuttingPlaneWidgetRef.current, plane);
        } else {
          const widget = createCuttingPlaneWidget({
            normal: plane.normal,
            originOffset: plane.originOffset,
            size: Math.max(...(modelBounds?.size || [200, 200, 200]))
          });
          sceneRef.current.add(widget);
          cuttingPlaneWidgetRef.current = widget;
        }
      } else {
        clearCuttingPlane();
      }
      
    } catch (error) {
      console.error('[CrossSection] Error applying plane:', error);
      setExecutionError(error.message);
    }
  };

  useEffect(() => {
    if (crossSectionEnabled && cachedMeshData) {
      handlePlaneChange(crossSectionPlane);
    } else if (!crossSectionEnabled && cachedMeshData) {
      // Restore original mesh when cross-section is disabled
      renderMeshData(cachedMeshData);
      clearCuttingPlane();
    }
  }, [crossSectionEnabled]);

  // Handle face click
  const handleCanvasClick = useCallback((event) => {
    if (!canvasRef.current || !cameraRef.current || !resultRef.current) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
    const intersects = raycasterRef.current.intersectObject(resultRef.current);
    
    if (intersects.length > 0) {
      const intersection = intersects[0];
      const clickedFace = intersection.face;
      const seedFaceIndex = intersection.faceIndex;
      const geometry = resultRef.current.geometry;
      const positions = geometry.attributes.position;
      const index = geometry.index.array;
      let centerSum = new Vector3();
      let totalArea = 0;
      const allVertices = [];
      const faceIndices = selectFaceByID(geometry, seedFaceIndex, {
        normal: [clickedFace.normal.x, clickedFace.normal.y, clickedFace.normal.z]
      });
      
      faceIndices.forEach(faceIdx => {
        const i0 = index[faceIdx * 3];
        const i1 = index[faceIdx * 3 + 1];
        const i2 = index[faceIdx * 3 + 2];
        const v1 = new Vector3().fromBufferAttribute(positions, i0);
        const v2 = new Vector3().fromBufferAttribute(positions, i1);
        const v3 = new Vector3().fromBufferAttribute(positions, i2);
        const triangle = new Triangle(v1, v2, v3);
        const area = triangle.getArea();
        const triCenter = new Vector3().add(v1).add(v2).add(v3).divideScalar(3);
        centerSum.add(triCenter.multiplyScalar(area));
        totalArea += area;
        allVertices.push([v1.x, v1.y, v1.z], [v2.x, v2.y, v2.z], [v3.x, v3.y, v3.z]);
      });
      
      const center = centerSum.divideScalar(totalArea);
      const normal = clickedFace.normal.clone();
      const faceData = {
        center: [center.x, center.y, center.z],
        normal: [normal.x, normal.y, normal.z],
        area: totalArea,
        vertices: allVertices,
        triangleCount: faceIndices.length
      };

      // Handle measurement mode
      if (measurementEnabled) {
        if (!measurementFaces.first) {
          // First face selected
          setMeasurementFaces({ first: faceData, second: null });
          
          // Highlight first face
          clearHighlight();
          highlightFace(faceIndices, geometry, positions, index, 0xffff00, 'first');
          
          console.log('[Measurement] First face selected');
        } else if (!measurementFaces.second) {
          // Second face selected - highlight and calculate
          setMeasurementFaces(prev => ({ ...prev, second: faceData }));
          highlightFace(faceIndices, geometry, positions, index, 0xffff00, 'second');
          
          console.log('[Measurement] Second face selected');
        } else {
          // Third face - restart with this as first
          setMeasurementFaces({ first: faceData, second: null });
          
          clearHighlight();
          highlightFace(faceIndices, geometry, positions, index, 0x00ff00);
          
          console.log('[Measurement] Restarted with new first face');
        }
      } else {
        // Normal face selection mode
        setSelectedFace(faceData);
        onFaceSelected?.(faceData);
        clearHighlight();
        highlightFace(faceIndices, geometry, positions, index, 0xffff00);
      }
    } else {
      // Clicked empty space
      if (measurementEnabled) {
        console.log("[Measurement] Keeping face selected for measurement")
      } else {
        clearHighlight();
        setSelectedFace(null);
        onFaceSelected?.(null);
      }
    }
  }, [onFaceSelected, measurementEnabled, measurementFaces]);

  // Effect for click handler
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    canvas.addEventListener('mousedown', handleCanvasClick);
    return () => {
      canvas.removeEventListener('mousedown', handleCanvasClick);
    };
  }, [handleCanvasClick]);

  // Helper function to highlight a face
  const highlightFace = useCallback((faceIndices, geometry, positions, index, color = 0xffff00, name = 'highlight') => {
    const highlightPositions = [];
    faceIndices.forEach(faceIdx => {
      const i0 = index[faceIdx * 3];
      const i1 = index[faceIdx * 3 + 1];
      const i2 = index[faceIdx * 3 + 2];
      const v1 = new Vector3().fromBufferAttribute(positions, i0);
      const v2 = new Vector3().fromBufferAttribute(positions, i1);
      const v3 = new Vector3().fromBufferAttribute(positions, i2);
      highlightPositions.push(
        v1.x, v1.y, v1.z,
        v2.x, v2.y, v2.z,
        v3.x, v3.y, v3.z
      );
    });
    
    const highlightGeometry = new BufferGeometry();
    highlightGeometry.setAttribute('position', new BufferAttribute(new Float32Array(highlightPositions), 3));
    const indices = [];
    for (let i = 0; i < faceIndices.length * 3; i++) {
      indices.push(i);
    }
    highlightGeometry.setIndex(indices);
    const edges = new EdgesGeometry(highlightGeometry);
    const edgesLine = new LineSegments(edges, new LineBasicMaterial({ 
      color, linewidth: 3, depthTest: true
    }));
    const highlightMesh = new ThreeMesh(highlightGeometry, new MeshBasicMaterial({
      color, transparent: true, opacity: 0.3, depthTest: true, side: 2
    }));
    highlightMesh.add(edgesLine);
    highlightMesh.name = name;
    sceneRef.current.add(highlightMesh);
    
    if (!highlightMeshRef.current) {
      highlightMeshRef.current = [];
    }
    highlightMeshRef.current.push(highlightMesh);
  }, []);

  // Initialize Three.js scene
  useEffect(() => {
    console.log('[Viewport] Initializing Three.js scene');
    if (!canvasRef.current || !containerRef.current) return;

    const container = containerRef.current;
    let initialized = false;
    
    const getContainerSize = () => {
      const size = {
        width: container.clientWidth,
        height: container.clientHeight
      };
      return size;
    };

    const initScene = () => {
      if (initialized) return;
      
      let { width, height } = getContainerSize();
      
      if (width === 0 || height === 0) {
        return;
      }
      
      initialized = true;

      const scene = new Scene();
      const camera = new PerspectiveCamera(45, width / height, 0.1, 2000);
      camera.position.set(300, 300, 300);
      camera.lookAt(0, 0, 0);
      const light = new PointLight(0xffffff, 1);
      camera.add(light);
      scene.add(camera);

      sceneRef.current = scene;
      cameraRef.current = camera;

      const renderer = new WebGLRenderer({
        canvas: canvasRef.current,
        antialias: true
      });

      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      rendererRef.current = renderer;

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      // Enable full 360° rotation
      controls.minPolarAngle = 0; // Remove lower limit
      controls.maxPolarAngle = Math.PI; // Remove upper limit (allow going upside down)
      controls.enableRotate = true;
      controlsRef.current = controls;

      // Add axis helper
      const axisHelper = new AxesHelper(50);
      sceneRef.current.add(axisHelper);
      axisHelperRef.current = axisHelper;
      axisHelperRef.current.visible = axisHelperEnabled;

      const animate = () => {
        requestAnimationFrame(animate);
        
        if (controlsRef.current) {
          controlsRef.current.update();
        }
        
        if (rendererRef.current && sceneRef.current && cameraRef.current) {
          try {
            rendererRef.current.render(sceneRef.current, cameraRef.current);
          } catch (error) {
            // Log debug info only on error
            const meshCount = sceneRef.current.children.filter(c => c.type === 'Mesh').length;
            const hasMaterials = resultRef.current?.material && Array.isArray(resultRef.current.material);
            const hasGeometry = resultRef.current?.geometry?.attributes?.position;
            
            console.error('[Animate] Render error:', error.message);
            console.error('[Animate] Scene state:', {
              meshCount,
              hasMaterials,
              hasGeometry,
              resultMaterial: resultRef.current?.material?.length || 'none',
              sceneChildren: sceneRef.current.children.length,
              highlightMeshes: Array.isArray(highlightMeshRef.current) ? highlightMeshRef.current.length : (highlightMeshRef.current ? 1 : 0)
            });
          }
        }
      };
      animate();
    };

    const handleResize = () => {
      if (!initialized) return;
      
      const { width, height } = getContainerSize();
      
      if (cameraRef.current) {
        cameraRef.current.aspect = width / height;
        cameraRef.current.updateProjectionMatrix();
      }
      
      if (rendererRef.current) {
        rendererRef.current.setSize(width, height);
        
        if (controlsRef.current) {
          controlsRef.current.update();
        }
        
        if (sceneRef.current && cameraRef.current) {
          rendererRef.current.render(sceneRef.current, cameraRef.current);
        }
      }
    };

    const resizeObserver = new ResizeObserver((entries) => {
      if (!initialized) {
        initScene();
      } else {
        handleResize();
      }
    });

    resizeObserver.observe(container);
    window.addEventListener('resize', handleResize);

    initScene();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
      if (rendererRef.current) {
        rendererRef.current.dispose();
      }
      if (resultRef.current?.geometry) {
        resultRef.current.geometry.dispose();
      }
      clearHighlight();
      clearCuttingPlane();
    };
  }, []);

  // Initialize materials
  useEffect(() => {
    const defineMaterials = () => {
      const matls = [
        new MeshNormalMaterial({ flatShading: true }),
        new MeshLambertMaterial({ color: 'red', flatShading: true }),
        new MeshLambertMaterial({ color: 'blue', flatShading: true })
      ];
      setMaterials(matls);

      const result = new ThreeMesh(undefined, matls);
      
      const scene = sceneRef.current;
      if (!scene) return;

      scene.add(result);
      resultRef.current = result;
    };
    defineMaterials();
  }, []);

  // Zoom camera to fit the model
  const handleZoomToFit = useCallback(() => {
    if (!resultRef.current?.geometry || !cameraRef.current || !controlsRef.current) return;
    
    const geometry = resultRef.current.geometry;
    geometry.computeBoundingBox();
    const boundingBox = geometry.boundingBox;
    
    if (!boundingBox) return;
    
    // Calculate bounding sphere
    const center = new Vector3();
    boundingBox.getCenter(center);
    
    const size = new Vector3();
    boundingBox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = cameraRef.current.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
    
    // Add some padding
    cameraZ *= 1.5;
    
    // Position camera
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    
    camera.position.set(center.x + cameraZ, center.y + cameraZ, center.z + cameraZ);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    
    // Update controls target
    controls.target.copy(center);
    controls.update();
    
    console.log('[Viewport] Zoomed to fit');
  }, []);

  const handleMeasurementToggle = () => {
    if (!measurementEnabled && selectedFace) {
      // Turning on measurement mode with a face already selected
      setMeasurementFaces({ first: selectedFace, second: null });
      // Keep the existing face highlighted - don't clear
    } else {
      // Turning off measurement mode or no face selected when turning on
      setMeasurementFaces({ first: null, second: null });
      if (measurementEnabled) {
        // Clear highlights when turning off measurement mode
        clearHighlight();
      }
    }
    
    setMeasurementEnabled(!measurementEnabled);
  };

  const handleAxisHelperToggle = () => {
    setAxisHelperEnabled(prev => {
      const newValue = !prev;
      if (axisHelperRef.current) {
        axisHelperRef.current.visible = newValue;
      }
      return newValue;
    });
  };

  // Helper to render mesh data from the worker
  const renderMeshData = useCallback((meshData) => {
    if (!meshData || !resultRef.current) return;

    const geometry = new BufferGeometry();
    
    // Convert arrays to typed arrays
    const vertProperties = new Float32Array(meshData.vertProperties);
    const triVerts = new Uint32Array(meshData.triVerts);
    
    geometry.setAttribute('position', new BufferAttribute(vertProperties, 3));
    geometry.setIndex(new BufferAttribute(triVerts, 1));

    if (meshData.faceID && meshData.faceID.length > 0) {
      geometry.setAttribute('faceID', new BufferAttribute(new Float32Array(meshData.faceID), 1));
    }

    // Set up material groups
    if (meshData.runIndex && meshData.runOriginalID) {
      const runIndex = meshData.runIndex;
      const runOriginalID = meshData.runOriginalID;
      
      let start = runIndex[0];
      for (let run = 0; run < meshData.numRun; ++run) {
        const end = runIndex[run + 1];
        // Map original ID to material index (simplified - use 0 for unknown)
        const matIndex = 0;
        geometry.addGroup(start, end - start, matIndex);
        start = end;
      }
    }

    geometry.computeVertexNormals();
    
    resultRef.current.geometry?.dispose();
    resultRef.current.geometry = geometry;

    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
  }, []);

  // Calculate model bounds from mesh data
  const calculateBoundsFromMesh = (meshData) => {
    const vertProperties = meshData.vertProperties;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    
    for (let i = 0; i < vertProperties.length; i += 3) {
      min[0] = Math.min(min[0], vertProperties[i]);
      min[1] = Math.min(min[1], vertProperties[i + 1]);
      min[2] = Math.min(min[2], vertProperties[i + 2]);
      max[0] = Math.max(max[0], vertProperties[i]);
      max[1] = Math.max(max[1], vertProperties[i + 1]);
      max[2] = Math.max(max[2], vertProperties[i + 2]);
    }
    
    return {
      min,
      max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
    };
  };

  /**
   * Execute script using the sandbox worker
   */
  const executeScript = useCallback(async (scriptOverride) => {
    const script = scriptOverride ?? currentScript;
    
    if (!script || !sceneRef.current) return;
    
    // Cancel any pending execution
    if (executionAbortRef.current) {
      executionAbortRef.current.aborted = true;
    }
    const abortController = { aborted: false };
    executionAbortRef.current = abortController;
    
    setIsExecuting(true);
    setExecutionError(null);

    clearHighlight();
    setSelectedFace(null);
    onFaceSelected?.(null);

    try {
      if (!manifoldContext.isReady) {
        throw new Error('Manifold Sandbox not initialized');
      }
      
      // Step 1: Validate script for dangerous patterns (client-side pre-check)
      console.log('[Viewport] Validating script...');
      const validation = validateScript(script);
      if (!validation.valid) {
        throw new Error(formatValidationErrors(validation.errors));
      }
      
      if (abortController.aborted) {
        console.log('[Viewport] Execution aborted during validation');
        return;
      }

      // Step 2: Load cached models into ManifoldContext
      const importedModels = parseImportedModels(script);
      for (let i = 0; i < importedModels.length; i++) {
        const modelData = await loadCachedModel(importedModels[i]);
        if (modelData) {
          manifoldContext.cacheImportedModel(importedModels[i], modelData);
        }
      }
      
      // Step 3: Execute script in sandbox worker
      console.log('[Viewport] Executing script in sandbox worker...');
      const result = await manifoldContext.executeScript(script, {
        timeoutMs: EXECUTION_LIMITS.timeoutMs,
        memoryLimitMB: EXECUTION_LIMITS.memoryLimitMB
      });
      
      if (abortController.aborted) {
        console.log('[Viewport] Execution aborted after worker returned');
        return;
      }
      
      const { mesh: meshData, memoryUsedMB } = result;
      
      if (!meshData || !meshData.vertProperties) {
        throw new Error('Script must return a Manifold object');
      }

      // Calculate bounds from mesh
      const bounds = calculateBoundsFromMesh(meshData);
      setModelBounds(bounds);

      // Cache mesh data for cross-section operations
      setCachedMeshData(meshData);

      // Render the result
      renderMeshData(meshData);
      
      if (memoryUsedMB) {
        console.log(`[Viewport] Memory after execution: ${memoryUsedMB.toFixed(1)}MB`);
      }
      
      console.log('[Viewport] Script executed successfully');

    } catch (error) {
      console.error('Error executing script:', error);
      setExecutionError(error.message || 'Script execution failed');

      if (resultRef.current) {
        resultRef.current.geometry?.dispose();
        resultRef.current.geometry = new BufferGeometry();
      }
    } finally {
      setIsExecuting(false);
      if (executionAbortRef.current === abortController) {
        executionAbortRef.current = null;
      }
    }
  }, [currentScript, materials, onFaceSelected, renderMeshData, clearHighlight]);

  /**
   * Download the current model as 3mf
   * Uses cached mesh data when available to avoid re-execution
   */
  const handleDownloadModel = useCallback(async () => {
    if (!cachedMeshData?.vertProperties) {
      setExecutionError('No model to export');
      return;
    }

    setIsDownloading(true);

    try {
      const filename = currentFilename || 'model';
      await downloadModelFromMesh(cachedMeshData, filename);
    } catch (error) {
      console.error('[Viewport] Export error:', error);
      setExecutionError(`Export failed: ${error.message}`);
    } finally {
      setIsDownloading(false);
    }
  }, [cachedMeshData, currentFilename]);

  return (
    <div ref={containerRef} className="relative w-full h-full bg-gray-900 overflow-hidden">
      <Toolbar
        onOpen={onOpen}
        onSave={onSave}
        onAccount={onAccount}
        onDownload={handleDownloadModel}
        onQuote={onQuote}
        onUpload={onUpload}
        onUndo={onUndo}
        onRedo={onRedo}
        canUndo={canUndo}
        canRedo={canRedo}
        isExecuting={isExecuting}
        isDownloading={isDownloading}
        isUploading={isUploading}
        currentFilename={currentFilename}
      />
      
      {/* Cross-Section Panel */}
        <CrossSectionPanel
          enabled={crossSectionEnabled}
          onToggle={handleCrossSectionToggle}
          onPlaneChange={handlePlaneChange}
          onZoomToFit={handleZoomToFit}
          bounds={modelBounds}
          measurementEnabled={measurementEnabled}
          onMeasurementToggle={handleMeasurementToggle}
          axisHelperEnabled={axisHelperEnabled}
          onAxisHelperToggle={handleAxisHelperToggle}
        />
      
      {executionError && (
        <div className="absolute top-16 right-4 bg-red-900/90 text-white p-3 rounded text-xs max-w-md z-10">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-bold mb-1">Execution Error</div>
              <div>{executionError}</div>
            </div>
            <button
              onClick={() => setExecutionError(null)}
              className="text-red-200 hover:text-white"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      
      {/* Face Info Display */}
      {selectedFace && !measurementEnabled && (
        <div className="absolute bottom-4 left-2 lg:left-4 bg-black/50 text-white rounded-lg text-xs font-mono z-10">
          <div className="font-bold mb-1">Selected Face</div>
          <div>Center: [{selectedFace.center.map(v => v.toFixed(1)).join(', ')}]</div>
          <div>Normal: [{selectedFace.normal.map(v => v.toFixed(2)).join(', ')}]</div>
          <div>Area: {selectedFace.area.toFixed(1)} mm²</div>
        </div>
      )}

      {/* Measurement Info Display */}
      {measurementEnabled && measurementFaces.first && (
        <div className="absolute bottom-4 left-2 lg:left-4 bg-black/50 backdrop-blur-sm text-white p-3 rounded-lg text-xs font-mono z-10 space-y-1">
          {measurementFaces.second ? (
            <>
                {(() => {
                  const measurements = calculateMeasurements(measurementFaces.first, measurementFaces.second);
                  return (
                    <>
                      <div className="text-gray-300">Normal: {measurements.normal.toFixed(2)} mm</div>
                      <div className="text-red-300">X: {measurements.x.toFixed(2)} mm</div>
                      <div className="text-green-300">Y: {measurements.y.toFixed(2)} mm</div>
                      <div className="text-blue-300">Z: {measurements.z.toFixed(2)} mm</div>
                    </>
                  );
                })()}
            </>
          ) : (
            <div className="text-gray-400">Select second face...</div>
          )}
        </div>
      )}
      
      <canvas ref={canvasRef} />
    </div>
  );
});

export default Viewport;
