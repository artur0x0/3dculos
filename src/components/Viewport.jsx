// components/Viewport.jsx
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  PointLight,
  Mesh as ThreeMesh,
  MeshLambertMaterial,
  MeshNormalMaterial,
  BufferGeometry,
  BufferAttribute
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import Module from '../../built/manifold';
import Toolbar from './Toolbar';

const Viewport = ({
  width = 600,
  height = 600,
  currentScript
}) => {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const resultRef = useRef(null);
  const [materials, setMaterials] = useState([]);
  const [isExecuting, setIsExecuting] = useState(false);

  // Debug: Log props changes
  useEffect(() => {
    console.log('[Viewport] Props updated:', { width, height, currentScript });
  }, [width, height, currentScript]);

  // Initialize Three.js scene
  useEffect(() => {
    console.log('[Viewport] Initializing Three.js scene');
    const init = async () => {
      if (!canvasRef.current) return;

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

      const maxSize = Math.sqrt(268435456); // Max allowed size
      const scale = Math.min(1, maxSize / Math.max(width, height));
      const finalWidth = Math.floor(width * scale);
      const finalHeight = Math.floor(height * scale);

      renderer.setSize(finalWidth, finalHeight, false);  // false preserves CSS size
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      rendererRef.current = renderer;

      // Controls setup
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controlsRef.current = controls;

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
    init();

    return () => {
      if (rendererRef.current) {
        rendererRef.current.dispose();
      }
      if (resultRef.current?.geometry) {
        resultRef.current.geometry.dispose();
      }
    };
  }, [width, height]);

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

    try {
      // Load Manifold WASM library
      const wasm = await Module();
      wasm.setup();
      const { Manifold } = wasm;

      // Set up Manifold IDs
      const firstID = Manifold.reserveIDs(materials.length);
      const ids = Array.from({ length: materials.length }, (_, idx) => firstID + idx);
      const id2matIndex = new Map();
      ids.forEach((id, idx) => id2matIndex.set(id, idx));

      // Helper function to convert Manifold mesh to Three.js geometry
      function mesh2geometry(mesh) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(mesh.vertProperties, 3));
        geometry.setIndex(new BufferAttribute(mesh.triVerts, 1));
    
        let id = mesh.runOriginalID[0];
        let start = mesh.runIndex[0];
        for (let run = 0; run < mesh.numRun; ++run) {
          const nextID = mesh.runOriginalID[run + 1];
          if (nextID !== id) {
            const end = mesh.runIndex[run + 1];
            geometry.addGroup(start, end - start, id2matIndex.get(id));
            id = nextID;
            start = end;
          }
        }
        return geometry;
      }

      // Execute user script
      console.log('[Viewport] Executing script:', currentScript);
      const scriptFn = new Function('Manifold', currentScript);
      console.log('[Viewport] Created function, executing with Manifold');
      const result = scriptFn(Manifold);
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
          const newGeometry = mesh2geometry(result.getMesh());
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
    } finally {
      setIsExecuting(false);
    }
  }, [currentScript, materials]);

  const handleAddFeature = useCallback((featureType) => {
    console.log('[Viewport] Adding feature:', featureType);
    // To be implemented
  }, []);

  return (
    <div className="relative w-full h-full bg-gray-900">
      <Toolbar
        onExecute={executeScript}
        isExecuting={isExecuting}
        onAddFeature={handleAddFeature}
      />
      <canvas
        ref={canvasRef}
        className="h-full"
      />
    </div>
  );
};

export default Viewport;