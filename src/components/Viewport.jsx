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
    const getContainerSize = () => ({
      width: container.clientWidth,
      height: container.clientHeight
    });

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
      }
      
      if (rendererRef.current) {
        rendererRef.current.setSize(width, height);
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
          console.log('[Viewport] Adding faceID attribute, length:', mesh.faceID.length);
          geometry.setAttribute('faceID', new BufferAttribute(mesh.faceID, 1));
        }

        // DEBUG: Log Three.js geometry structure
        console.log('=== THREE.JS GEOMETRY ===');
        console.log('Geometry:', geometry);
        console.log('Attributes:', geometry.attributes);
        console.log('Index:', geometry.index);
        console.log('Groups (before adding):', geometry.groups);
        console.log('=========================');

        let start = mesh.runIndex[0];
        for (let run = 0; run < mesh.numRun; ++run) {
          const end = mesh.runIndex[run + 1];
          const id = mesh.runOriginalID[run];
          let matIndex = id2matIndex.get(id);
          if (matIndex === undefined) {
            matIndex = 0; // Fallback to first material
          }

          // DEBUG: Log each run/group
          console.log(`Run ${run}: start=${start}, end=${end}, triangles=${(end-start)/3}, originalID=${id}, matIndex=${matIndex}`);
        
          geometry.addGroup(start, end - start, matIndex);
          start = end;
        }

        // Important: compute normals for face detection
        geometry.computeVertexNormals();

        // DEBUG: Log final geometry state
        console.log('=== FINAL GEOMETRY ===');
        console.log('Groups after adding:', geometry.groups);
        console.log('Normals:', geometry.attributes.normal);
        console.log('======================');
      
        return geometry;
      }

      // Execute user script with all wasm exports available
      console.log('[Viewport] Executing script:', currentScript);
      const wasmKeys = Object.keys(wasm);
      const wasmValues = Object.values(wasm);
      const scriptFn = new Function(...wasmKeys, currentScript);
      console.log('[Viewport] Created function with wasm exports:', wasmKeys);
      const result = scriptFn(...wasmValues);
      console.log('[Viewport] Script execution result:', result);
      
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

          // DEBUG: Log Manifold mesh structure
          console.log('=== MANIFOLD MESH DATA ===');
          console.log('Manifold mesh:', manifoldMesh);
          console.log('numRun:', manifoldMesh.numRun);
          console.log('runIndex:', manifoldMesh.runIndex);
          console.log('runOriginalID:', manifoldMesh.runOriginalID);
          console.log('runTransform:', manifoldMesh.runTransform);
          console.log('triVerts (indices):', manifoldMesh.triVerts);
          console.log('vertProperties (positions):', manifoldMesh.vertProperties);
          console.log('=========================');

          const newGeometry = mesh2geometry(manifoldMesh);

          console.log('[Viewport] Created new geometry:', newGeometry);
          resultRef.current.geometry = newGeometry;
        } else {
          console.log('[Viewport] Creating new mesh');
          const geometry = mesh2geometry(result.getMesh());
          console.log('[Viewport] Created new geometry:', geometry);
          const material = new MeshLambertMaterial({
            color: 0x156289,
            emissive: 0x072534,
            side: 2,
            flatShading: true
          });
          const mesh = new ThreeMesh(geometry, material);
          console.log('[Viewport] Created new mesh:', mesh);
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

  return (
    <div ref={containerRef} className="relative w-full h-full bg-gray-900 overflow-hidden">
      <Toolbar
        onOpen={onOpen}
        onSave={onSave}
        onRun={executeScript}
        onDownload={handleDownloadModel}
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