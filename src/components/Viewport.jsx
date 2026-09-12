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
  Vector4,
  Matrix4,
  Triangle,
  LineSegments,
  LineBasicMaterial
} from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import Toolbar from './Toolbar';
import CrossSectionPanel from './CrossSectionPanel';
import { X } from 'lucide-react';
import { downloadModelFromMesh, get3MFBase64FromMesh } from '../utils/exportModel';
import { parseImportedModels, loadCachedModel } from '../utils/importModel';
import { calculateQuote } from '../utils/quoting';
import { selectFaceByID, selectFaceWithTolerance, selectAllConnected } from '../utils/selectFace';
import { createCuttingPlaneWidget, updateCuttingPlaneWidget } from '../utils/cuttingPlaneWidget';
import { AxesHelper } from 'three';
import { calculateMeasurements, createMeasurementLines, disposeMeasurementLines } from '../utils/measurementTool';
import { fitView, VIEW_PRESETS } from '../utils/viewCamera';
import ViewSnapControl from './ViewSnapControl';
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
  // Mirrors the last execution error for the dev-only __VIEWPORT__ hook (the real handler
  // stores it in state, which a headless caller cannot read synchronously).
  const stageExecErrorRef = useRef(null);

  const clickCountRef = useRef(0);
  const clickTimerRef = useRef(null);
  const lastClickTimeRef = useRef(0);
  const pendingClickDataRef = useRef(null);
  const mouseDownPosRef = useRef({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const measurementLinesRef = useRef(null); 

  // Configuration for click detection
  const MULTI_CLICK_DELAY = 300; // ms to wait for additional clicks
  const ANGLE_TOLERANCE_DEGREES = 3; // Angular tolerance for double-click selection
  const DRAG_THRESHOLD = 3; // pixels - movement beyond this is considered a drag
  
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
  const [cachedMeshData, setCachedMeshData] = useState(null);
  
  // Measurement tool and axis helper state
  const [measurementEnabled, setMeasurementEnabled] = useState(false);
  const [measurementFaces, setMeasurementFaces] = useState({ first: null, second: null });
  const [axisHelperEnabled, setAxisHelperEnabled] = useState(false);
  // Re-frame the part after each successful run, preserving the current orbit direction.
  const [autoFitEnabled, setAutoFitEnabled] = useState(true);

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

  // Helper function to highlight a face - with boundary edges only
  const highlightFace = useCallback((faceIndices, geometry, positions, index, color = 0xffff00, name = 'highlight') => {
    const highlightPositions = [];
    const edgeCount = new Map(); // Track how many times each edge appears
    
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
      
      // Track edges (use sorted vertex indices as key)
      const edges = [
        [Math.min(i0, i1), Math.max(i0, i1)],
        [Math.min(i1, i2), Math.max(i1, i2)],
        [Math.min(i2, i0), Math.max(i2, i0)]
      ];
      
      edges.forEach(([a, b]) => {
        const key = `${a}-${b}`;
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      });
    });
    
    // Build boundary edges (edges that appear only once)
    const boundaryEdgePositions = [];
    edgeCount.forEach((count, key) => {
      if (count === 1) {
        const [a, b] = key.split('-').map(Number);
        const v1 = new Vector3().fromBufferAttribute(positions, a);
        const v2 = new Vector3().fromBufferAttribute(positions, b);
        boundaryEdgePositions.push(v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
      }
    });
    
    // Create highlight mesh
    const highlightGeometry = new BufferGeometry();
    highlightGeometry.setAttribute('position', new BufferAttribute(new Float32Array(highlightPositions), 3));
    const indices = [];
    for (let i = 0; i < faceIndices.length * 3; i++) {
      indices.push(i);
    }
    highlightGeometry.setIndex(indices);
    
    const highlightMesh = new ThreeMesh(highlightGeometry, new MeshBasicMaterial({
      color, transparent: true, opacity: 0.3, depthTest: true, side: 2
    }));
    highlightMesh.name = name;
    
    // Create boundary edge lines only
    if (boundaryEdgePositions.length > 0) {
      const edgeGeometry = new BufferGeometry();
      edgeGeometry.setAttribute('position', new BufferAttribute(new Float32Array(boundaryEdgePositions), 3));
      const edgesLine = new LineSegments(edgeGeometry, new LineBasicMaterial({ 
        color, linewidth: 3, depthTest: true
      }));
      highlightMesh.add(edgesLine);
    }
    
    sceneRef.current.add(highlightMesh);
    
    if (!highlightMeshRef.current) {
      highlightMeshRef.current = [];
    }
    highlightMeshRef.current.push(highlightMesh);
  }, []);

  const clearMeasurementLines = useCallback(() => {
    if (measurementLinesRef.current && sceneRef.current) {
      sceneRef.current.remove(measurementLinesRef.current);
      disposeMeasurementLines(measurementLinesRef.current);
      measurementLinesRef.current = null;
    }
  }, []);

  const updateMeasurementVisualization = useCallback((face1, face2) => {
    // Clear existing measurement lines
    clearMeasurementLines();
    
    if (face1 && face2 && sceneRef.current) {
      // Create new measurement lines
      const lines = createMeasurementLines(face1, face2);
      sceneRef.current.add(lines);
      measurementLinesRef.current = lines;
    }
  }, [clearMeasurementLines]);

  /**
   * Handle mouse down - record position for drag detection
   */
  const handleMouseDown = useCallback((event) => {
    mouseDownPosRef.current = { x: event.clientX, y: event.clientY };
    isDraggingRef.current = false;
  }, []);

  /**
   * Handle mouse move - detect if dragging
   */
  const handleMouseMove = useCallback((event) => {
    if (mouseDownPosRef.current) {
      const dx = event.clientX - mouseDownPosRef.current.x;
      const dy = event.clientY - mouseDownPosRef.current.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance > DRAG_THRESHOLD) {
        isDraggingRef.current = true;
      }
    }
  }, []);

  /**
   * Handle mouse up - process click only if not dragging
   */
  const handleMouseUp = useCallback((event) => {
    // If user was dragging, don't process as a click
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      return;
    }
    
    if (!canvasRef.current || !cameraRef.current || !resultRef.current) return;
    
    // Calculate mouse position and perform raycast
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
    const intersects = raycasterRef.current.intersectObject(resultRef.current);
    
    // Handle click on empty space (only if not dragging)
    if (intersects.length === 0) {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      clickCountRef.current = 0;
      pendingClickDataRef.current = null;
      
      if (measurementEnabled) {
        console.log("[Measurement] Keeping face selected for measurement");
      } else {
        clearHighlight();
        setSelectedFace(null);
        onFaceSelected?.(null);
      }
      return;
    }
    
    // Capture intersection data
    const intersection = intersects[0];
    const clickedFace = intersection.face;
    const seedFaceIndex = intersection.faceIndex;
    const geometry = resultRef.current.geometry;
    const positions = geometry.attributes.position;
    const index = geometry.index.array;
    
    const clickData = {
      clickedFace,
      seedFaceIndex,
      geometry,
      positions,
      index,
      faceNormal: [clickedFace.normal.x, clickedFace.normal.y, clickedFace.normal.z]
    };
    
    // Multi-click detection
    const now = Date.now();
    if (now - lastClickTimeRef.current > MULTI_CLICK_DELAY) {
      clickCountRef.current = 0;
    }
    
    clickCountRef.current++;
    lastClickTimeRef.current = now;
    pendingClickDataRef.current = clickData;
    
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
    }
    
    // Process click after delay
    clickTimerRef.current = setTimeout(() => {
      processClick();
    }, MULTI_CLICK_DELAY);
    
  }, [onFaceSelected, measurementEnabled, measurementFaces, clearHighlight]);

  /**
   * Process the pending click based on click count
   * This is called after the multi-click delay has passed
   */
  const processClick = useCallback(() => {
    const clickData = pendingClickDataRef.current;
    if (!clickData) return;
    
    const { clickedFace, seedFaceIndex, geometry, positions, index, faceNormal } = clickData;
    const clickCount = clickCountRef.current;
    
    // Reset click tracking
    clickCountRef.current = 0;
    clickTimerRef.current = null;
    pendingClickDataRef.current = null;
    
    // Determine which selection function to use based on click count
    let faceIndices;
    let selectionMode;
    
    if (clickCount >= 3) {
      // Triple click: select all connected triangles
      faceIndices = selectAllConnected(geometry, seedFaceIndex);
      selectionMode = 'all-connected';
      console.log(`[Face Selection] Triple-click: selecting all ${faceIndices.length} connected triangles`);
    } else if (clickCount === 2) {
      // Double click: select faces within angular tolerance
      faceIndices = selectFaceWithTolerance(geometry, seedFaceIndex, { normal: faceNormal }, ANGLE_TOLERANCE_DEGREES);
      selectionMode = 'angular-tolerance';
      console.log(`[Face Selection] Double-click: selecting ${faceIndices.length} triangles within ${ANGLE_TOLERANCE_DEGREES}° tolerance`);
    } else {
      // Single click: select exact coplanar faces
      faceIndices = selectFaceByID(geometry, seedFaceIndex, { normal: faceNormal });
      selectionMode = 'coplanar';
      console.log(`[Face Selection] Single-click: selecting ${faceIndices.length} coplanar triangles`);
    }
    
    // Calculate face data (center, area, vertices) from selected triangles
    let centerSum = new Vector3();
    let totalArea = 0;
    const allVertices = [];
    
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
      triangleCount: faceIndices.length,
      selectionMode // Include selection mode in face data for UI display
    };
    
    // Handle measurement mode
    if (measurementEnabled) {
      handleMeasurementClick(faceData, faceIndices, geometry, positions, index);
    } else {
      // Normal face selection mode
      setSelectedFace(faceData);
      onFaceSelected?.(faceData);
      clearHighlight();
      highlightFace(faceIndices, geometry, positions, index, 0xffff00);
    }
    
  }, [measurementEnabled, measurementFaces, onFaceSelected, clearHighlight, highlightFace]);

  /**
   * Handle face selection in measurement mode
   */
  const handleMeasurementClick = useCallback((faceData, faceIndices, geometry, positions, index) => {
    if (!measurementFaces.first) {
      // First face selected - clear any existing measurement lines
      clearMeasurementLines();
      setMeasurementFaces({ first: faceData, second: null });
      
      // Highlight first face in green
      clearHighlight();
      highlightFace(faceIndices, geometry, positions, index, 0x00ff00, 'first');
      
      console.log('[Measurement] First face selected');
    } else if (!measurementFaces.second) {
      // Second face selected - highlight and create measurement visualization
      setMeasurementFaces(prev => {
        // Create measurement lines with both faces
        updateMeasurementVisualization(prev.first, faceData);
        return { ...prev, second: faceData };
      });
      highlightFace(faceIndices, geometry, positions, index, 0xffff00, 'second');
      
      console.log('[Measurement] Second face selected');
    } else {
      // Third click - restart with this as first face
      clearMeasurementLines();
      setMeasurementFaces({ first: faceData, second: null });
      
      clearHighlight();
      highlightFace(faceIndices, geometry, positions, index, 0x00ff00, 'first');
      
      console.log('[Measurement] Restarted with new first face');
    }
  }, [measurementFaces, clearHighlight, highlightFace, clearMeasurementLines, updateMeasurementVisualization]);

  // --- Event listener setup ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseDown, handleMouseMove, handleMouseUp]);

  // Click cleanup effect
  useEffect(() => {
    return () => {
      // Cleanup click timer on unmount
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
      }
      // Cleanup measurement lines on unmount
      clearMeasurementLines();
    };
  }, [clearMeasurementLines]);

  useEffect(() => {
    if (!measurementEnabled) {
      clearMeasurementLines();
    }
  }, [measurementEnabled, clearMeasurementLines]);

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

      // Dev/automation hook used by headless review tooling (harness/stage_shot.mjs).
      // Drives the exact same execute -> render path the Run button uses, and lets a
      // script position the camera deterministically for reproducible screenshots.
      const __tris = () => {
        const g = resultRef.current?.geometry;
        if (!g) return 0;
        return g.index ? Math.ceil(g.index.count / 3)
          : (g.attributes?.position ? Math.ceil(g.attributes.position.count / 3) : 0);
      };
      if (import.meta.env?.DEV) {
        window.__VIEWPORT__ = {
          ready: () => !!(sceneRef.current && rendererRef.current && resultRef.current),
          // Set this from automation to be notified the instant a mesh lands in the scene.
          // Fires from renderMeshData with the exact meshData object that was painted.
          onRendered: null,
          _lastRenderedMesh: null,
          _renderCount: 0,
          lastRenderedIs: (mesh) => window.__VIEWPORT__?._lastRenderedMesh === mesh,
          // Run a script exactly as the Run button does -- validate, execute in the worker,
          // render into the live scene, auto-fit. Resolves { error, mesh } so a headless
          // caller can tell a fresh build from a failure without reading React state.
          executeScript: async (s) => {
            stageExecErrorRef.current = null;
            try {
              await executeScript(s);
            } catch (e) {
              stageExecErrorRef.current = String(e?.message || e);
            }
            const err = stageExecErrorRef.current;
            const mesh = err ? null : (window.__MANIFOLD_CONTEXT__?.lastResult?.mesh ?? null);
            // Identity check against the render choke point: the object we painted is the
            // object the worker just returned, or this run did not reach the screen at all.
            return {
              error: err,
              mesh,
              onScreen: !!mesh && window.__VIEWPORT__?._lastRenderedMesh === mesh,
              sceneTris: __tris(),
            };
          },
          // az/el in degrees, z-up world (the app models parts with +Z up). Delegates to
          // the same fitView the UI buttons use, so an automated capture frames the part
          // exactly as a manual snap would.
          stageFit: ({ az = 35, el = 20, margin = 1.15, viewTarget = null } = {}) => {
            const cam = cameraRef.current, ctl = controlsRef.current, res = resultRef.current;
            if (!cam || !res || !res.geometry) return false;
            const azr = (az * Math.PI) / 180, elr = (el * Math.PI) / 180;
            const ok = fitView({
              camera: cam, controls: ctl, geometry: res.geometry,
              dir: [Math.cos(elr) * Math.cos(azr), Math.cos(elr) * Math.sin(azr), Math.sin(elr)],
              up: [0, 0, 1], margin,
            });
            renderer.render(sceneRef.current, cam);
            return ok;
          },
          stageSnap: (key, margin = 1.15) => {
            const known = Object.prototype.hasOwnProperty.call(VIEW_PRESETS, key) ? key : 'iso';
            const ok = handleViewSnap(known, margin);
            renderer.render(sceneRef.current, cameraRef.current);
            return ok;
          },
          stageAutoFit: (on) => { setAutoFitEnabled(!!on); return true; },
          // Framing assertion for automated review: projects the part's 8 bounding-box
          // corners through the live camera and reports whether they land inside the
          // viewport and how much of it the part covers. A snap that silently no-ops, a
          // part rendered off-screen tiny, or geometry clipped by near/far all fail here
          // with a readable reason -- which pixels alone would not reliably tell us.
          stageVerifyFraming: (maxTriangles = 200000) => {
            const cam = cameraRef.current, res = resultRef.current;
            if (!cam || !res?.geometry?.attributes?.position) return { ok: false, problems: ['no camera or geometry'] };
            const g = res.geometry;
            g.computeBoundingBox();
            const b = g.boundingBox;
            if (!b || b.isEmpty()) return { ok: false, problems: ['empty bounding box'] };

            cam.updateMatrixWorld();      // this fork refreshes matrixWorldInverse inside updateMatrixWorld()
            const mvp = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
            const p = new Vector4();
            let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
            let behindNear = 0, beyondFar = 0, invalid = 0;
            const nearZ = -(cam.far + cam.near) / (cam.far - cam.near);
            const farZ = 1;
            for (let i = 0; i < 8; i++) {
              p.set(
                i & 1 ? b.max.x : b.min.x,
                i & 2 ? b.max.y : b.min.y,
                i & 4 ? b.max.z : b.min.z,
                1
              ).applyMatrix4(mvp);
              if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z) || Math.abs(p.w) < 1e-12) { invalid++; continue; }
              const u = p.x / p.w, vv = p.y / p.w, z = p.z / p.w;
              minU = Math.min(minU, u); maxU = Math.max(maxU, u);
              minV = Math.min(minV, vv); maxV = Math.max(maxV, vv);
              if (z < nearZ - 1e-3) behindNear++;
              if (z > farZ + 1e-3) beyondFar++;
            }
            if (invalid === 8) return { ok: false, problems: ['projection produced no finite corners'] };

            const problems = [];
            if (behindNear === 8) problems.push('part is entirely in front of the near plane');
            if (beyondFar === 8) problems.push('part is entirely beyond the far plane');
            // The part's largest projected extent, as a fraction of the half-frame. A correct
            // fit sits in [~0.5, ~1.0]: the biggest dimension fills the frame (minus the margin
            // factor) and nothing spills outside it. This is the right test, not total frame
            // coverage -- a long thin part viewed down its long axis legitimately covers a small
            // fraction of the frame while being framed perfectly.
            const extent = Math.max(Math.abs(minU), Math.abs(maxU), Math.abs(minV), Math.abs(maxV));
            if (!Number.isFinite(extent)) problems.push('non-finite projection');
            else if (extent > 1.05) problems.push(`part projects outside the frame (largest extent ${extent.toFixed(2)} of half-frame)`);
            else if (extent < 0.40) problems.push(`part fills only ${(extent * 100).toFixed(0)}% of the frame (not fitted)`);
            const covU = Math.max(0, Math.min(1, maxU) - Math.max(-1, minU));
            const covV = Math.max(0, Math.min(1, maxV) - Math.max(-1, minV));
            // Normalised to [0..1]: the visible NDC box is [-1,1]^2, an area of 4. Reported
            // for context only -- it is expected to be small for slender parts.
            const coverage = (covU * covV) / 4;

            return {
              ok: problems.length === 0,
              problems,
              extent: Number.isFinite(extent) ? +extent.toFixed(3) : null,
              u: [minU, maxU].map((x) => +x.toFixed(3)),
              v: [minV, maxV].map((x) => +x.toFixed(3)),
              coverage: +coverage.toFixed(3),
              tris: Math.ceil((g.index ? g.index.count : g.attributes.position.count) / 3),
            };
          },
          // Framing state for automated assertions (headless callers cannot read refs).
          stageCamera: () => {
            const cam = cameraRef.current, ctl = controlsRef.current, res = resultRef.current;
            if (!cam) return null;
            const g = res?.geometry;
            g?.computeBoundingBox();
            const b = g?.boundingBox;
            // zoom/view/projection-matrix readouts for headless forensics. For this fork the
            // verified identities are te[5] = zoom / tan(fov_deg * PI/180 / 2) and te[0] =
            // te[5] / aspect (near cancels out — makePerspective scales width with near).
            // Measured once: te = {1.293, 2.414} <=> exactly fov 45, aspect 1.867 — so a
            // mismatch here means someone mutated fov/aspect/zoom, not that the fit is bad.
            const pe = cam.projectionMatrix?.elements || null;
            return {
              position: cam.position.toArray(),
              up: cam.up.toArray(),
              target: ctl ? ctl.target.toArray() : null,
              near: cam.near, far: cam.far, fov: cam.fov, aspect: cam.aspect,
              zoom: cam.zoom, view: cam.view ? { ...cam.view } : null,
              te: pe ? { te0: pe[0], te5: pe[5], te8: pe[8], te9: pe[9] } : null,
              bbox: b && !b.isEmpty() ? { min: b.min.toArray(), max: b.max.toArray() } : null,
            };
          },
          // Fullscreen the viewport and hide every non-canvas element (toolbars, panels,
          // editor, modals) so captures show only the part on a clean background.
          stageIsolate: ({ bg = '#0d1116' } = {}) => {
            const container = containerRef.current, canvas = canvasRef.current;
            if (!container || !canvas) return false;
            const keep = new Set();
            for (let el = canvas; el; el = el.parentElement) keep.add(el);
            for (const el of document.querySelectorAll('body *')) {
              if (keep.has(el)) continue;
              el.style.setProperty('display', 'none', 'important');
            }
            for (const ch of Array.from(container.children)) {
              if (ch !== canvas) ch.style.setProperty('display', 'none', 'important');
            }
            container.style.setProperty('position', 'fixed', 'important');
            container.style.setProperty('inset', '0', 'important');
            container.style.setProperty('width', '100vw', 'important');
            container.style.setProperty('height', '100vh', 'important');
            container.style.setProperty('margin', '0', 'important');
            container.style.setProperty('border', 'none', 'important');
            container.style.setProperty('z-index', '2147483647', 'important');
            container.style.setProperty('background', bg, 'important');
            canvas.style.setProperty('display', 'block', 'important');
            canvas.style.setProperty('width', '100vw', 'important');
            canvas.style.setProperty('height', '100vh', 'important');
            return true;
          },
          stageSize: (w, h) => {
            const r = rendererRef.current, c = cameraRef.current;
            if (!r || !c) return false;
            r.setSize(w, h);
            r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            c.aspect = w / h;
            c.updateProjectionMatrix();
            renderer.render(sceneRef.current, c);
            return true;
          },
          setAxes: (on) => { setAxisHelperEnabled(!!on); return true; },
        };
      }

      const controls = new TrackballControls(camera, renderer.domElement);
      controls.enableDamping = true;
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

  // Zoom camera to fit the model (keeps the current orbit direction)
  const handleZoomToFit = useCallback(() => {
    if (!resultRef.current?.geometry || !cameraRef.current) return;
    if (fitView({ camera: cameraRef.current, controls: controlsRef.current, geometry: resultRef.current.geometry })) {
      console.log('[Viewport] Zoomed to fit');
    }
  }, []);

  // Snap to a canonical view (iso / front / right / top) and re-fit in the same gesture.
  const handleViewSnap = useCallback((key, margin = 1.15) => {
    const preset = VIEW_PRESETS[key] || VIEW_PRESETS.iso;
    if (!resultRef.current?.geometry || !cameraRef.current) return false;
    const ok = fitView({
      camera: cameraRef.current,
      controls: controlsRef.current,
      geometry: resultRef.current.geometry,
      dir: preset.dir,
      up: preset.up,
      margin,
    });
    if (ok) console.log(`[Viewport] Snapped to ${preset.label}`);
    return ok;
  }, []);

  const handleAutoFitToggle = useCallback(() => {
    setAutoFitEnabled((on) => {
      const next = !on;
      if (next) handleZoomToFit();
      return next;
    });
  }, [handleZoomToFit]);

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

    // Dev-only: the single choke point where geometry reaches the scene. Report the exact
    // meshData object we just painted so automation can prove, by identity, that what is on
    // screen is the part it submitted -- no polling, no timers, no retry logic.
    if (import.meta.env?.DEV && window.__VIEWPORT__) {
      const hook = window.__VIEWPORT__;
      hook._lastRenderedMesh = meshData;
      hook._renderCount = (hook._renderCount || 0) + 1;
      try { hook.onRendered?.(meshData); } catch (e) { console.warn('[stage] onRendered failed:', e?.message); }
    }

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

      // Auto scale: re-frame the part after every successful run so the new geometry is
      // never left off-screen or tiny. Keeps the user's current orbit direction.
      if (autoFitEnabled) {
        const bounds = calculateBoundsFromMesh(meshData);
        if (bounds) handleZoomToFit();
      }
      
      if (memoryUsedMB) {
        console.log(`[Viewport] Memory after execution: ${memoryUsedMB.toFixed(1)}MB`);
      }
      
      console.log('[Viewport] Script executed successfully');

    } catch (error) {
      console.error('Error executing script:', error);
      const msg = error.message || 'Script execution failed';
      stageExecErrorRef.current = msg;
      setExecutionError(msg);

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
  }, [currentScript, materials, onFaceSelected, renderMeshData, clearHighlight, autoFitEnabled, handleZoomToFit]);

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
          onAutoFitToggle={handleAutoFitToggle}
          autoFitEnabled={autoFitEnabled}
          onSnapView={handleViewSnap}
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
