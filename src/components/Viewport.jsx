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
import Module from '../../built/manifold';
import Toolbar from './Toolbar';
import { X } from 'lucide-react';
import { saveAs } from 'file-saver';

const Viewport = forwardRef(({ 
  currentScript, 
  onFaceSelected, 
  onOpen,
  onSave,
  onQuote,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  currentFilename
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
  const [selectedFace, setSelectedFace] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionError, setExecutionError] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);

  useImperativeHandle(ref, () => ({
    executeScript,
    clearFaceSelection: () => {
      clearHighlight();
      setSelectedFace(null);
      onFaceSelected?.(null);
    },
    export3MF: export3MFBase64,
    calculateQuote: async (options) => {
      return await calculateQuote(options);
    }
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

  // Select all triangles with same faceID and recursively expand to coplanar adjacent faceIDs
  const selectFaceByID = useCallback((geometry, seedFaceIndex, faceData) => {
    console.log('[Face Selection] Selecting face by faceID from triangle', seedFaceIndex);
    
    const faceIDs = geometry.attributes.faceID;
    if (!faceIDs) {
      console.warn('[Face Selection] No faceID attribute found, selecting single triangle');
      return [seedFaceIndex];
    }
    
    // Find which group this triangle belongs to
    const groups = geometry.groups;
    let targetGroup = null;
    const indexInBuffer = seedFaceIndex * 3;
    
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (indexInBuffer >= group.start && indexInBuffer < group.start + group.count) {
        targetGroup = group;
        console.log('[Face Selection] Target group:', i, group);
        break;
      }
    }
    
    const targetNormal = new Vector3(faceData.normal[0], faceData.normal[1], faceData.normal[2]);
    const NORMAL_THRESHOLD = 0.001; // Element-wise tolerance

    console.log("[Face Selection] Target Normal is: ", targetNormal);
    
    // Helper: Check if two normals are the same (element-wise)
    const normalsMatch = (n1, n2) => {
      return Math.abs(n1.x - n2.x) < NORMAL_THRESHOLD &&
             Math.abs(n1.y - n2.y) < NORMAL_THRESHOLD &&
             Math.abs(n1.z - n2.z) < NORMAL_THRESHOLD;
    };
    
    // Helper: Get normal for a triangle (compute from vertices, same as raycaster)
    const getFaceNormal = (faceIdx) => {
      const positions = geometry.attributes.position;
      const index = geometry.index.array;
      
      const i0 = index[faceIdx * 3];
      const i1 = index[faceIdx * 3 + 1];
      const i2 = index[faceIdx * 3 + 2];
      
      const v0 = new Vector3().fromBufferAttribute(positions, i0);
      const v1 = new Vector3().fromBufferAttribute(positions, i1);
      const v2 = new Vector3().fromBufferAttribute(positions, i2);
      
      // Calculate face normal from cross product (same as raycaster does)
      const edge1 = new Vector3().subVectors(v1, v0);
      const edge2 = new Vector3().subVectors(v2, v0);
      const normal = new Vector3().crossVectors(edge1, edge2).normalize();
      
      return normal;
    };
    
    // Build edge-to-triangle map for the group
    const edgeToTriangles = new Map();
    const numTriangles = geometry.index.count / 3;
    const index = geometry.index.array;
    
    for (let triIdx = 0; triIdx < numTriangles; triIdx++) {
      const triIndexInBuffer = triIdx * 3;
      if (targetGroup) {
        if (triIndexInBuffer < targetGroup.start || 
            triIndexInBuffer >= targetGroup.start + targetGroup.count) {
          continue;
        }
      }
      
      const i0 = index[triIdx * 3];
      const i1 = index[triIdx * 3 + 1];
      const i2 = index[triIdx * 3 + 2];
      
      const edges = [
        [Math.min(i0, i1), Math.max(i0, i1)],
        [Math.min(i1, i2), Math.max(i1, i2)],
        [Math.min(i2, i0), Math.max(i2, i0)]
      ];
      
      edges.forEach(([v1, v2]) => {
        const key = `${v1}-${v2}`;
        if (!edgeToTriangles.has(key)) {
          edgeToTriangles.set(key, []);
        }
        edgeToTriangles.get(key).push(triIdx);
      });
    }
    
    // Helper: Get all adjacent triangles to a set of triangles
    const getAdjacentTriangles = (triangles) => {
      const adjacent = new Set();
      
      for (const triIdx of triangles) {
        const i0 = index[triIdx * 3];
        const i1 = index[triIdx * 3 + 1];
        const i2 = index[triIdx * 3 + 2];
        
        const edges = [
          [Math.min(i0, i1), Math.max(i0, i1)],
          [Math.min(i1, i2), Math.max(i1, i2)],
          [Math.min(i2, i0), Math.max(i2, i0)]
        ];
        
        edges.forEach(([v1, v2]) => {
          const key = `${v1}-${v2}`;
          const adjacentTris = edgeToTriangles.get(key) || [];
          adjacentTris.forEach(adjIdx => adjacent.add(adjIdx));
        });
      }
      
      return Array.from(adjacent);
    };
    
    // Recursive function to find all coplanar faceIDs
    const findCoplanarFaceIDs = (currentFaceID, visited) => {
      if (visited.has(currentFaceID)) return;
      visited.add(currentFaceID);
      
      // Get all triangles with this faceID in the group
      const trianglesWithID = [];
      for (let i = 0; i < faceIDs.count; i++) {
        if (faceIDs.array[i] !== currentFaceID) continue;
        
        const triIndexInBuffer = i * 3;
        if (targetGroup) {
          if (triIndexInBuffer >= targetGroup.start && 
              triIndexInBuffer < targetGroup.start + targetGroup.count) {
            trianglesWithID.push(i);
          }
        } else {
          trianglesWithID.push(i);
        }
      }
      
      if (trianglesWithID.length === 0) return;
      
      // Get adjacent triangles
      const adjacent = getAdjacentTriangles(trianglesWithID);
      
      // Check each adjacent triangle's faceID and normal
      for (const adjIdx of adjacent) {
        const adjFaceID = faceIDs.array[adjIdx];
        
        // Skip if already visited
        if (visited.has(adjFaceID)) continue;
        
        // Check if normal matches
        const adjNormal = getFaceNormal(adjIdx);
        if (normalsMatch(targetNormal, adjNormal)) {
          // Recursively process this faceID
          findCoplanarFaceIDs(adjFaceID, visited);
        }
      }
    };
    
    // Start recursive search from seed faceID
    const seedFaceID = faceIDs.array[seedFaceIndex];
    const selectedFaceIDs = new Set();
    findCoplanarFaceIDs(seedFaceID, selectedFaceIDs);
    
    console.log('[Face Selection] Found coplanar faceIDs:', Array.from(selectedFaceIDs));
    
    // Collect all triangles with any of the selected faceIDs
    const result = [];
    for (let i = 0; i < faceIDs.count; i++) {
      if (!selectedFaceIDs.has(faceIDs.array[i])) continue;
      
      const triIndexInBuffer = i * 3;
      if (targetGroup) {
        if (triIndexInBuffer >= targetGroup.start && 
            triIndexInBuffer < targetGroup.start + targetGroup.count) {
          result.push(i);
        }
      } else {
        result.push(i);
      }
    }
    
    console.log(`[Face Selection] Selected ${result.length} triangles across ${selectedFaceIDs.size} faceIDs`);
    return result;
  }, []);

  // Handle face click
  const handleCanvasClick = useCallback((event) => {
    if (!canvasRef.current || !cameraRef.current || !resultRef.current) return;
    
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();

    // Calculate mouse position in normalized device coordinates
    mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    
    raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
    const intersects = raycasterRef.current.intersectObject(resultRef.current);
    
    if (intersects.length > 0) {
      const intersection = intersects[0];
      const clickedFace = intersection.face;
      const seedFaceIndex = intersection.faceIndex;
      const geometry = resultRef.current.geometry;
      
      // Calculate face data from all selected triangles
      const positions = geometry.attributes.position;
      const index = geometry.index.array;
      let centerSum = new Vector3();
      let totalArea = 0;
      const allVertices = [];

      // Select all triangles with same faceID and coplanar adjacent faceIDs
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
      
      // Get normal from the clicked triangle
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
      
      // Create highlight geometry from all selected triangles
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
  }, [onFaceSelected, selectFaceByID]);

  // Initialize Three.js scene
  useEffect(() => {
    console.log('[Viewport] Initializing Three.js scene');
    if (!canvasRef.current || !containerRef.current) return;

    const container = containerRef.current;
    let initialized = false;
    
    // Get actual container dimensions
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
      
      // Don't initialize if container has no size yet
      if (width === 0 || height === 0) {
        console.log('[Viewport] Container not ready, waiting...');
        return;
      }
      
      console.log('[Viewport] Container ready:', { width, height });
      initialized = true;

      // Scene setup
      const scene = new Scene();
      const camera = new PerspectiveCamera(45, width / height, 0.1, 2000);
      camera.position.set(300, 300, 300);
      camera.lookAt(0, 0, 0);
      const light = new PointLight(0xffffff, 1);
      camera.add(light);
      scene.add(camera);

      sceneRef.current = scene;
      cameraRef.current = camera;

      // Renderer setup
      const renderer = new WebGLRenderer({
        canvas: canvasRef.current,
        antialias: true
      });

      renderer.setSize(width, height);
      console.log('[Viewport] Renderer initialized with size:', { width, height });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      rendererRef.current = renderer;

      // Controls setup
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controlsRef.current = controls;

      // Click handler for face selection
      canvasRef.current.addEventListener('mousedown', handleCanvasClick);

      // Animation loop
      const animate = () => {
        requestAnimationFrame(animate);
        if (controlsRef.current) {
          controlsRef.current.update();
        }
        renderer.render(scene, camera);
      };
      animate();
    };

    // Handle resize
    const handleResize = () => {
      if (!initialized) return;
      
      const { width, height } = getContainerSize();
      
      if (cameraRef.current) {
        cameraRef.current.aspect = width / height;
        cameraRef.current.updateProjectionMatrix();
        console.log("[Viewport] Camera aspect changed to ", cameraRef.current.aspect );
      }
      
      if (rendererRef.current) {
        rendererRef.current.setSize(width, height);
        console.log('[Viewport] Renderer re-rendered with size:', { width, height });
        
        // Debug canvas dimensions
        if (canvasRef.current) {
          console.log('[Viewport] Canvas internal:', canvasRef.current.width, 'x', canvasRef.current.height);
          console.log('[Viewport] Canvas CSS:', canvasRef.current.style.width, canvasRef.current.style.height);
          console.log('[Viewport] Canvas client:', canvasRef.current.clientWidth, 'x', canvasRef.current.clientHeight);
        }
        
        // Update controls
        if (controlsRef.current) {
          controlsRef.current.update();
          console.log('[Viewport] Controls updated');
        }
        
        // Force an immediate render
        if (sceneRef.current && cameraRef.current) {
          rendererRef.current.render(sceneRef.current, cameraRef.current);
          console.log('[Viewport] Forced immediate render after resize');
        }
      }
    };

    // Use ResizeObserver to detect when container gets dimensions
    const resizeObserver = new ResizeObserver((entries) => {
      if (!initialized) {
        initScene();
      } else {
        handleResize();
      }
    });

    resizeObserver.observe(container);
    window.addEventListener('resize', handleResize);

    // Try immediate init in case container already has size
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
      if (canvasRef.current) {
        canvasRef.current.removeEventListener('mousedown', handleCanvasClick);
      }
      clearHighlight();
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

  // Handle script execution and mesh updates
  const executeScript = useCallback(async () => {
    if (!currentScript || !sceneRef.current) return;
    setIsExecuting(true);

    // Clear face selection when executing new script
    clearHighlight();
    setSelectedFace(null);
    onFaceSelected?.(null);

    try {
      // Load Manifold WASM library
      const wasm = await Module();
      wasm.setup();

      // Set up Manifold IDs
      const { Manifold } = wasm;
      const firstID = Manifold.reserveIDs(materials.length);
      const ids = Array.from({ length: materials.length }, (_, idx) => firstID + idx);
      const id2matIndex = new Map();
      ids.forEach((id, idx) => id2matIndex.set(id, idx));

      // Helper function to convert Manifold mesh to Three.js geometry
      function mesh2geometry(mesh) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(mesh.vertProperties, 3));
        geometry.setIndex(new BufferAttribute(mesh.triVerts, 1));

        // Preserve faceID if available
        if (mesh.faceID && mesh.faceID.length > 0) {
          geometry.setAttribute('faceID', new BufferAttribute(mesh.faceID, 1));
        }

        let start = mesh.runIndex[0];
        for (let run = 0; run < mesh.numRun; ++run) {
          const end = mesh.runIndex[run + 1];
          const id = mesh.runOriginalID[run];
          let matIndex = id2matIndex.get(id);
          if (matIndex === undefined) {
            matIndex = 0; // Fallback to first material
          }

          geometry.addGroup(start, end - start, matIndex);
          start = end;
        }

        // Important: compute normals for face detection
        geometry.computeVertexNormals();
      
        return geometry;
      }

      // Execute user script with all wasm exports available
      console.log('[Viewport] Executing script');
      const wasmKeys = Object.keys(wasm);
      const wasmValues = Object.values(wasm);
      const scriptFn = new Function(...wasmKeys, currentScript);
      const result = scriptFn(...wasmValues);
      
      // Check if result is a valid Manifold object
      if (!result || typeof result.getMesh !== 'function') {
        console.error('[Viewport] Invalid result - not a Manifold object:', result);
        return;
      }

      if (result) {
        // Update the mesh
        if (resultRef.current) {
          console.log('[Viewport] Updating existing mesh');
          resultRef.current.geometry?.dispose();

          const manifoldMesh = result.getMesh();
          const newGeometry = mesh2geometry(manifoldMesh);

          resultRef.current.geometry = newGeometry;
        } else {
          console.log('[Viewport] Creating new mesh');
          const geometry = mesh2geometry(result.getMesh());
          const material = new MeshLambertMaterial({
            color: 0x156289,
            emissive: 0x072534,
            side: 2,
            flatShading: true
          });
          const mesh = new ThreeMesh(geometry, material);
          sceneRef.current.add(mesh);
          resultRef.current = mesh;
        }

        // Render the scene
        const renderer = rendererRef.current;
        const scene = sceneRef.current;
        const camera = cameraRef.current;
        if (renderer && scene && camera) {
          console.log('[Viewport] Rendering scene');
          renderer.render(scene, camera);
        }
      }
    } catch (error) {
      console.error('Error executing script:', error);
      setExecutionError(error.message || 'Script execution failed');

      // Clear geometry on error
      if (resultRef.current) {
        resultRef.current.geometry?.dispose();
        resultRef.current.geometry = new BufferGeometry();
      }
    } finally {
      setIsExecuting(false);
    }
  }, [currentScript, materials, onFaceSelected]);

  // Common 3MF blob generation function
  const generate3MFBlob = useCallback(async () => {
    if (!currentScript || !sceneRef.current || !resultRef.current?.geometry) {
      throw new Error('No model to export');
    }

    // Load Manifold WASM library
    const wasm = await Module();
    wasm.setup();

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
  }, [currentScript]);

  // Download 3MF file to users machine
  const handleDownloadModel = useCallback(async () => {
    if (!currentScript || !sceneRef.current || !resultRef.current?.geometry) return;

    setIsDownloading(true);

    try {
      // Load Manifold WASM library
      const wasm = await Module();
      wasm.setup();

      // Re-execute to get fresh Manifold result
      const wasmKeys = Object.keys(wasm);
      const wasmValues = Object.values(wasm);
      const scriptFn = new Function(...wasmKeys, currentScript);
      const result = scriptFn(...wasmValues);

      if (!result || typeof result.getMesh !== 'function') {
        console.error('Invalid manifold result for export');
        return;
      }

      const manifoldMesh = result.getMesh();

      // Convert to Three.js BufferGeometry (same as used for rendering)
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(manifoldMesh.vertProperties, 3));
      geometry.setIndex(new BufferAttribute(manifoldMesh.triVerts, 1));

      // Create a Three.js Mesh (material doesn't matter for geometry export)
      const mesh = new ThreeMesh(geometry, new MeshBasicMaterial());

      // Import the exporter
      const { exportTo3MF } = await import('three-3mf-exporter');

      // Export directly to Blob
      const blob = await exportTo3MF(mesh);

      saveAs(blob, 'model.3mf');
      console.log('3MF exported successfully using three-3mf-exporter');
    } catch (error) {
      console.error('Error exporting 3MF:', error);
    } finally {
      setIsDownloading(false);
    }
  }, [currentScript]);

  // Export 3MF for fabrication
  const export3MFBase64 = useCallback(async () => {
    try {
      const blob = await generate3MFBlob();
      
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
  }, [generate3MFBlob]);

  const calculateQuote = useCallback(async (options) => {
    const { process, material, infill } = options;
    
    if (!currentScript || !sceneRef.current) {
      throw new Error('No model to quote');
    }

    try {
      // Load Manifold WASM library and execute script to get the result
      const wasm = await Module();
      wasm.setup();

      const wasmKeys = Object.keys(wasm);
      const wasmValues = Object.values(wasm);
      const scriptFn = new Function(...wasmKeys, currentScript);
      const result = scriptFn(...wasmValues);

      if (!result || typeof result.volume !== 'function') {
        throw new Error('Invalid manifold result');
      }

      // Get volume directly from Manifold
      const volume = result.volume(); // mm³
      
      // Get bounding box for surface area estimation
      const bbox = result.boundingBox();
      const width = bbox.max[0] - bbox.min[0];
      const height = bbox.max[1] - bbox.min[1];
      const depth = bbox.max[2] - bbox.min[2];

      // Define max build volumes for each process
      const processLimits = {
        'FDM': { x: 256, y: 256, z: 256 },
        'SLA': { x: 145, y: 145, z: 175 },
        'SLS': { x: 300, y: 300, z: 300 },
        'MP': { x: 250, y: 250, z: 250 }
      };
    
      const limits = processLimits[process] || processLimits['FDM'];
      
      // Check if part fits within build volume
      if (width > limits.x || height > limits.y || depth > limits.z) {
        throw new Error(
          `Part is too large for ${process} process. ` +
          `Part size: ${width.toFixed(0)} × ${height.toFixed(0)} × ${depth.toFixed(0)} mm. ` +
          `Max printable size: ${limits.x} × ${limits.y} × ${limits.z} mm. \n`
        );
      }
      
      // Estimate surface area (rough approximation for a box-like shape)
      // For more accuracy, we could use surfaceArea() if available
      const surfaceArea = 2 * (width * height + width * depth + height * depth);

      console.log('[Quote] Volume:', volume, 'mm³');
      console.log('[Quote] Bounding box:', { width, height, depth });
      console.log('[Quote] Estimated surface area:', surfaceArea, 'mm²');

      // Material properties
      const materialData = {
        'PLA': { density: 1.24, costPerKg: 20, printSpeed: 60 },// mm/s
        'PETG': { density: 1.27, costPerKg: 25, printSpeed: 45 },
        'ABS': { density: 1.04, costPerKg: 22, printSpeed: 45 },
        'TPU': { density: 1.21, costPerKg: 40, printSpeed: 25 },
        'Nylon': { density: 1.14, costPerKg: 45, printSpeed: 35 }
      };

      const matData = materialData[material] || materialData['PLA'];
      
      // Calculate material usage
      const infillRatio = infill / 100;
      const wallThickness = 1.2; // mm (3 perimeters at 0.4mm)
      
      // Estimate solid volume (walls + infill)
      const shellVolume = surfaceArea * wallThickness;
      const infillVolume = volume * infillRatio;
      const totalSolidVolume = Math.min(shellVolume + infillVolume, volume);
      
      // Convert to grams
      const volumeCm3 = totalSolidVolume / 1000; // mm³ to cm³
      const materialGrams = volumeCm3 * matData.density;
      
      // Estimate print time - factor in infill
      const printSpeed = matData.printSpeed; // mm/s average
      const layerHeight = 0.2; // mm
      const numLayers = height / layerHeight;

      // Break down print time by component
      const perimeterLength = surfaceArea * 2; // Outer walls (constant regardless of infill)

      // Estimate infill path length based on volume and infill percentage
      // Higher infill = more material to print = longer time
      const infillPathLength = (volume / layerHeight) * infillRatio * 0.5; // Rough approximation

      // Total extrusion path
      const totalPathLength = perimeterLength + infillPathLength;

      // Calculate time (path time + layer change overhead)
      const printTimeHours = (totalPathLength / printSpeed / 3600) + (numLayers * 5 / 3600);
      
      // Calculate costs
      const materialCost = (materialGrams / 1000) * matData.costPerKg;
      const machineCost = printTimeHours * 5; // $5/hour
      const totalCost = materialCost + machineCost;
      
      return {
        materialUsage: {
          grams: parseFloat(materialGrams.toFixed(1)),
          meters: 0
        },
        printTime: parseFloat(printTimeHours.toFixed(1)),
        costs: {
          material: parseFloat(materialCost.toFixed(2)),
          machine: parseFloat(machineCost.toFixed(2)),
          total: parseFloat(totalCost.toFixed(2))
        },
        infill,
        material,
        volume: parseFloat(volume.toFixed(1)),
        surfaceArea: parseFloat(surfaceArea.toFixed(1))
      };
    } catch (error) {
      console.error('[Quote] Calculation error:', error);
      throw error;
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
        onUndo={onUndo}
        onRedo={onRedo}
        canUndo={canUndo}
        canRedo={canRedo}
        isExecuting={isExecuting}
        isDownloading={isDownloading}
        currentFilename={currentFilename}
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
      <canvas 
        ref={canvasRef}
      />
    </div>
  );
});

export default Viewport;