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
import { downloadModel, export3MFBase64 } from '../utils/downloads';
import { calculateQuote } from '../utils/quoting';
import { selectFaceByID } from '../utils/selectFace';
import { getManifoldBounds } from '../utils/crossSection';
import { createCuttingPlaneWidget, updateCuttingPlaneWidget } from '../utils/cuttingPlaneWidget';

const Viewport = forwardRef(({ 
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
  
  const [selectedFace, setSelectedFace] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionError, setExecutionError] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);
  
  // Cross-section state
  const [crossSectionEnabled, setCrossSectionEnabled] = useState(false);
  const [crossSectionPlane, setCrossSectionPlane] = useState({
    normal: [0, 0, 1],
    originOffset: 0,
    showPlane: true
  });
  const [modelBounds, setModelBounds] = useState(null);
  const [cachedManifold, setCachedManifold] = useState(null);

  useImperativeHandle(ref, () => ({
    executeScript,
    clearFaceSelection: () => {
      clearHighlight();
      setSelectedFace(null);
      onFaceSelected?.(null);
    },
    export3MF: () => export3MFBase64(currentScript),
    calculateQuote: async (options) => {
      return await calculateQuote(currentScript, options);
    },
    zoomToFit: handleZoomToFit 
  }));

  // Clear face highlight
  const clearHighlight = () => {
    if (highlightMeshRef.current && sceneRef.current) {
      sceneRef.current.remove(highlightMeshRef.current);
      highlightMeshRef.current.geometry?.dispose();
      highlightMeshRef.current.material?.dispose();
      highlightMeshRef.current = null;
    }
  };

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
        if (!window.Manifold || !currentScript) return;
        setCrossSectionEnabled(true);
        console.log('[CrossSection] Cached manifold for preview');
      } catch (error) {
        console.error('[CrossSection] Failed to cache manifold:', error);
      }
    } else {
      // Disable and restore original
      setCrossSectionEnabled(false);
      clearCuttingPlane();
    }
  };

  // Handle plane changes - use cached manifold for preview
  const handlePlaneChange = async (plane) => {
    console.log("[VIEWPORT] Handling plane change to ", plane)
    setCrossSectionPlane(plane);
    
    if (!crossSectionEnabled || !cachedManifold) return;
    
    try {
      // Apply trimByPlane to cached manifold
      const normal = new Vector3(...plane.normal).normalize();
      const normalArray = [normal.x, normal.y, normal.z];
      
      const trimmed = cachedManifold.trimByPlane(normalArray, plane.originOffset);
      
      // Render the trimmed preview
      renderManifold(trimmed);
      
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
    if (crossSectionEnabled && cachedManifold) {
      handlePlaneChange(crossSectionPlane);
    } else {
      executeScript(currentScript);
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
      
      setSelectedFace(faceData);
      onFaceSelected?.(faceData);
      clearHighlight();
      
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
        color: 0xffff00, linewidth: 3, depthTest: false 
      }));
      
      const highlightMesh = new ThreeMesh(highlightGeometry, new MeshBasicMaterial({
        color: 0xffff00, transparent: true, opacity: 0.3, depthTest: false, side: 2
      }));
      highlightMesh.add(edgesLine);
      
      sceneRef.current.add(highlightMesh);
      highlightMeshRef.current = highlightMesh;
    } else {
      clearHighlight();
      setSelectedFace(null);
      onFaceSelected?.(null);
    }
  }, [onFaceSelected]);

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
      console.log('[Viewport] getContainerSize called:', size);
      return size;
    };

    const initScene = () => {
      if (initialized) return;
      
      let { width, height } = getContainerSize();
      
      if (width === 0 || height === 0) {
        console.log('[Viewport] Container not ready, waiting...');
        return;
      }
      
      console.log('[Viewport] Container ready:', { width, height });
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
      console.log('[Viewport] Renderer initialized with size:', { width, height });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      rendererRef.current = renderer;

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      // Enable full 360° rotation
      controls.minPolarAngle = 0; // Remove lower limit
      controls.maxPolarAngle = Math.PI; // Remove upper limit (allow going upside down)
      controls.enableRotate = true;
      controlsRef.current = controls;

      const animate = () => {
        requestAnimationFrame(animate);
        if (controlsRef.current) {
          controlsRef.current.update();
        }
        renderer.render(scene, camera);
      };
      animate();
    };

    const handleResize = () => {
      if (!initialized) return;
      
      const { width, height } = getContainerSize();
      
      if (cameraRef.current) {
        cameraRef.current.aspect = width / height;
        cameraRef.current.updateProjectionMatrix();
        console.log("[Viewport] Camera aspect changed to", cameraRef.current.aspect);
      }
      
      if (rendererRef.current) {
        rendererRef.current.setSize(width, height);
        console.log('[Viewport] Renderer re-rendered with size:', { width, height });
        
        if (controlsRef.current) {
          controlsRef.current.update();
          console.log('[Viewport] Controls updated');
        }
        
        if (sceneRef.current && cameraRef.current) {
          rendererRef.current.render(sceneRef.current, cameraRef.current);
          console.log('[Viewport] Forced immediate render after resize');
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

  // Separate effect for click handler
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    canvas.addEventListener('mousedown', handleCanvasClick);
    return () => {
      canvas.removeEventListener('mousedown', handleCanvasClick);
    };
  }, [handleCanvasClick]);

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

  // Helper to render a manifold object
  const renderManifold = useCallback((manifold) => {
    if (!manifold || !resultRef.current) return;

    const wasm = window.Manifold;
    const { Manifold } = wasm;
    const firstID = Manifold.reserveIDs(materials.length);
    const ids = Array.from({ length: materials.length }, (_, idx) => firstID + idx);
    const id2matIndex = new Map();
    ids.forEach((id, idx) => id2matIndex.set(id, idx));

    function mesh2geometry(mesh) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(mesh.vertProperties, 3));
      geometry.setIndex(new BufferAttribute(mesh.triVerts, 1));

      if (mesh.faceID && mesh.faceID.length > 0) {
        geometry.setAttribute('faceID', new BufferAttribute(mesh.faceID, 1));
      }

      let start = mesh.runIndex[0];
      for (let run = 0; run < mesh.numRun; ++run) {
        const end = mesh.runIndex[run + 1];
        const id = mesh.runOriginalID[run];
        let matIndex = id2matIndex.get(id);
        if (matIndex === undefined) {
          matIndex = 0;
        }

        geometry.addGroup(start, end - start, matIndex);
        start = end;
      }

      geometry.computeVertexNormals();
      return geometry;
    }

    resultRef.current.geometry?.dispose();
    const manifoldMesh = manifold.getMesh();
    const newGeometry = mesh2geometry(manifoldMesh);
    resultRef.current.geometry = newGeometry;

    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
  }, [materials]);

  // Handle script execution
  const executeScript = useCallback(async () => {
    if (!currentScript || !sceneRef.current) return;
    setIsExecuting(true);

    clearHighlight();
    setSelectedFace(null);
    onFaceSelected?.(null);

    try {
      if (!window.Manifold) {
        throw new Error('Manifold WASM not loaded');
      }
      
      const wasm = window.Manifold;
      const wasmKeys = Object.keys(wasm);
      const wasmValues = Object.values(wasm);
      const scriptFn = new Function(...wasmKeys, currentScript);
      const result = scriptFn(...wasmValues);
      
      if (!result || typeof result.getMesh !== 'function') {
        console.error('[Viewport] Invalid result - not a Manifold object:', result);
        return;
      }

      // Get and store bounds
      const bounds = getManifoldBounds(currentScript);
      setModelBounds(bounds);

      // Cache manifold
      setCachedManifold(result);

      // Always render full model on execution
      renderManifold(result);

    } catch (error) {
      console.error('Error executing script:', error);
      setExecutionError(error.message || 'Script execution failed');

      if (resultRef.current) {
        resultRef.current.geometry?.dispose();
        resultRef.current.geometry = new BufferGeometry();
      }
    } finally {
      setIsExecuting(false);
    }
  }, [currentScript, materials, onFaceSelected, renderManifold]);

  const handleDownloadModel = useCallback(async () => {
    if (!currentScript || !sceneRef.current || !resultRef.current?.geometry) return;

    setIsDownloading(true);

    try {
      await downloadModel(currentScript);
    } catch (error) {
      console.error('Error exporting 3MF:', error);
    } finally {
      setIsDownloading(false);
    }
  }, [currentScript]);

  return (
    <div ref={containerRef} className="relative w-full h-full bg-gray-900 overflow-hidden">
      <Toolbar
        onOpen={onOpen}
        onSave={onSave}
        onRun={executeScript}
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
      
      {selectedFace && (
        <div className="absolute bottom-4 left-4 bg-black/80 text-white p-3 rounded text-xs font-mono z-10">
          <div className="font-bold mb-1">Selected Face</div>
          <div>Center: [{selectedFace.center.map(v => v.toFixed(1)).join(', ')}]</div>
          <div>Normal: [{selectedFace.normal.map(v => v.toFixed(2)).join(', ')}]</div>
          <div>Area: {selectedFace.area.toFixed(1)} mm²</div>
        </div>
      )}
      
      <canvas ref={canvasRef} />
    </div>
  );
});

export default Viewport;
