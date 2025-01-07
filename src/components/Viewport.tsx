import React, { useEffect, useRef, useState } from 'react';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  IcosahedronGeometry,
  Mesh as ThreeMesh,
  MeshLambertMaterial,
  MeshNormalMaterial,
  PerspectiveCamera,
  PointLight,
  Scene,
  WebGLRenderer
} from 'three';

import Module, { Mesh } from '../../built/manifold';

type BooleanOp = 'union' | 'difference' | 'intersection';

interface ManifoldViewerProps {
  width?: number;
  height?: number;
  defaultOperation?: BooleanOp;
}

const Viewport: React.FC<ManifoldViewerProps> = ({
  width = 600,
  height = 600,
  defaultOperation = 'union'
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [operation, setOperation] = useState<BooleanOp>(defaultOperation);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const cameraRef= useRef<PerspectiveCamera | null>(null);
  const resultRef = useRef<ThreeMesh | null>(null);
  const [materials, setMaterials] = useState([{}])

  useEffect(() => {
    const init = async () => {
      if (!canvasRef.current) return;

      // Initialize Three.js scene
      const scene = new Scene();
      const camera = new PerspectiveCamera(30, width / height, 0.01, 10);
      camera.position.z = 1;
      const light = new PointLight(0xffffff, 1);
      camera.add(light);
      scene.add(camera);

      // Store refs for later use
      sceneRef.current = scene;
      cameraRef.current = camera;

      // Initialize renderer
      const renderer = new WebGLRenderer({
        canvas: canvasRef.current,
        antialias: true
      });
      renderer.setSize(width, height);
      renderer.render(scene, camera);
      rendererRef.current = renderer;
    }
    init();

    // Cleanup
    return () => {
      if (rendererRef.current) {
        rendererRef.current.dispose();
      }
      if (resultRef.current?.geometry) {
        resultRef.current.geometry.dispose();
      }
    };
  }, []);

  useEffect(() => {
    const defineMaterials = () => {
      const matls = [
        new MeshNormalMaterial({ flatShading: true }),
        new MeshLambertMaterial({ color: 'red', flatShading: true }),
        new MeshLambertMaterial({ color: 'blue', flatShading: true })
      ];
      setMaterials(matls)

      const result = new ThreeMesh(undefined, matls);

      const scene = sceneRef.current;
      if (!scene) return;

      scene.add(result);
      resultRef.current = result;
    }
    defineMaterials();
  },[])

  useEffect(() => {
    const build = async () => {
      // Load Manifold WASM library
      const wasm = await Module();
      wasm.setup();
      const { Manifold, Mesh } = wasm;

      // Set up Manifold IDs
      const firstID = Manifold.reserveIDs(materials.length);
      const ids = Array.from({ length: materials.length }, (_, idx) => firstID + idx);
      const id2matIndex = new Map();
      ids.forEach((id, idx) => id2matIndex.set(id, idx)); 

      // Create geometries
      const cube = new BoxGeometry(0.2, 0.2, 0.2);
      cube.clearGroups();
      cube.addGroup(0, 18, 0);
      cube.addGroup(18, Infinity, 1);

      const icosahedron = new IcosahedronGeometry(0.16);
      icosahedron.clearGroups();
      icosahedron.addGroup(30, Infinity, 2);
      icosahedron.addGroup(0, 30, 0);

      // Helper functions
      function geometry2mesh(geometry: BufferGeometry): Mesh {
        const vertProperties = geometry.attributes.position.array as Float32Array;
        const triVerts = geometry.index != null ?
          geometry.index.array as Uint32Array :
          new Uint32Array(vertProperties.length / 3).map((_, idx) => idx);
    
        const starts = Array.from(geometry.groups, group => group.start);
        const originalIDs = geometry.groups.map(group => ids[group.materialIndex!]);
        
        const indices = Array.from(starts.keys());
        indices.sort((a, b) => starts[a] - starts[b]);
        const runIndex = new Uint32Array(indices.map(i => starts[i]));
        const runOriginalID = new Uint32Array(indices.map(i => originalIDs[i]));
    
        const mesh = new Mesh({
          numProp: 3,
          vertProperties,
          triVerts,
          runIndex,
          runOriginalID
        });
        mesh.merge();
        return mesh;
      }

      // Convert to Manifolds
      const manifoldCube = new Manifold(geometry2mesh(cube));
      const manifoldIcosahedron = new Manifold(geometry2mesh(icosahedron));

      function mesh2geometry(mesh: Mesh): BufferGeometry {
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

      // Function to perform CSG operations
      function performCSG(op: BooleanOp) {
        if (resultRef.current) {
          resultRef.current.geometry?.dispose();
          resultRef.current.geometry = mesh2geometry(
            Manifold[op](manifoldCube, manifoldIcosahedron).getMesh()
          );
        }
      }

      // Initial CSG operation
      performCSG(operation);

      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      if (!renderer || !scene || !camera) return;
      renderer.render(scene, camera);
    };
    build();
  },[operation])

  return (
    <div className="flex flex-col items-center p-4 bg-gray-100">
      <div className="max-w-2xl mb-4">
        Hello, Manifold. This is 3dculos.
      </div>
      
      <select 
        value={operation}
        onChange={(e) => setOperation(e.target.value as BooleanOp)}
        className="mb-4 p-2 border rounded"
      >
        <option value="union">Union</option>
        <option value="difference">Difference</option>
        <option value="intersection">Intersection</option>
      </select>

      <canvas
        ref={canvasRef}
        className="w-full max-w-[600px] aspect-square"
      />
    </div>
  );
};

export default Viewport;