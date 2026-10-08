/**
 * Browser half of the sheet-material golden. Renders with the production
 * material and overlay, then samples pixels. Served through Vite.
 */
import * as THREE from 'three';
import { buildSheetOverlay } from '../../src/utils/sheetMetal/sheetOverlay.js';
import { makeSheetMetalMaterial } from '../../src/utils/sheetMetal/sheetMaterial.js';

const W = 390;
const H = 700;

function geomFrom(meshData) {
  const np = meshData.numProp || 3;
  const src = meshData.vertProperties;
  const nVert = Math.floor(src.length / np);
  const positions = new Float32Array(nVert * 3);
  for (let i = 0; i < nVert; i++) {
    positions[i * 3] = src[i * np];
    positions[i * 3 + 1] = src[i * np + 1];
    positions[i * 3 + 2] = src[i * np + 2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(meshData.triVerts), 1));
  g.computeVertexNormals();
  return g;
}

function sample(renderer, bg) {
  const gl = renderer.getContext();
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const br = (bg >> 16) & 255;
  const bgg = (bg >> 8) & 255;
  const bb = bg & 255;
  let n = 0;
  let lum = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sat = 0;
  let orange = 0;
  let yellow = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = ((H - 1 - y) * W + x) * 4;
      const r = buf[i];
      const g = buf[i + 1];
      const b = buf[i + 2];
      if (Math.abs(r - br) < 8 && Math.abs(g - bgg) < 8 && Math.abs(b - bb) < 8) continue;
      const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      lum += L;
      sr += r;
      sg += g;
      sb += b;
      n++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 30) sat++;
      if (r > 170 && r > g + 40 && b < 120) orange++;
      if (r > 190 && g > 190 && r - b > 40 && g - b > 40) yellow++;
    }
  }
  return {
    pixels: n,
    mean: n ? lum / n : 0,
    r: n ? sr / n : 0,
    g: n ? sg / n : 0,
    b: n ? sb / n : 0,
    satFrac: n ? sat / n : 0,
    orange,
    yellow,
  };
}

function frame(camera, object, fromBelow = false) {
  const box = new THREE.Box3().setFromObject(object);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const dist = sphere.radius / Math.sin((45 * Math.PI) / 360) * 1.4;
  const dir = new THREE.Vector3(1, 0.85, fromBelow ? -0.95 : 0.95).normalize();
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  camera.up.set(0, 0, 1);
  camera.lookAt(sphere.center);
}

function shot(renderer, scene, camera, bg, build) {
  scene.background = new THREE.Color(bg);
  renderer.setClearColor(bg, 1);
  while (scene.children.length) scene.remove(scene.children[0]);
  scene.add(camera);
  const root = build();
  scene.add(root);
  frame(camera, root, build.fromBelow === true);
  renderer.render(scene, camera);
  return {
    ...sample(renderer, bg),
    png: renderer.domElement.toDataURL('image/png'),
  };
}

/** @param {HTMLCanvasElement} canvas @param {{ sheet: object, cube: object, spec: object }} payload */
export function renderSheetMaterialShots(canvas, payload) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(W, H, false);
  renderer.setPixelRatio(1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 2000);
  const light = new THREE.PointLight(0xffffff, 1);
  camera.add(light);

  const sheetGeom = geomFrom(payload.sheet);
  const cubeGeom = geomFrom(payload.cube);
  const sheetMat = makeSheetMetalMaterial();
  const overlayMode = { stage: 'edit', spec: payload.spec, tool: 'bend', previewSpec: payload.spec };

  const sheetBody = () => {
    const m = new THREE.Mesh(sheetGeom, sheetMat);
    return m;
  };
  const under = () => sheetBody();
  under.fromBelow = true;
  const overlay = () => buildSheetOverlay(overlayMode);
  const highlighted = () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(sheetGeom, sheetMat));
    const hi = new THREE.Mesh(sheetGeom, new THREE.MeshBasicMaterial({
      color: 0xffff00,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    }));
    hi.renderOrder = 2;
    group.add(hi);
    return group;
  };
  const cube = () => new THREE.Mesh(cubeGeom, new THREE.MeshNormalMaterial({ flatShading: true }));

  const dark = 0x1e1e1e;
  const lightBg = 0xf4f5f7;
  const out = {
    material: {
      type: sheetMat.type,
      color: sheetMat.color.getHex(),
      metalness: sheetMat.metalness,
      roughness: sheetMat.roughness,
      side: sheetMat.side,
      flatShading: sheetMat.flatShading,
      sheet: sheetMat.userData.sheetMetal === true,
    },
    faceDark: shot(renderer, scene, camera, dark, sheetBody),
    faceLight: shot(renderer, scene, camera, lightBg, sheetBody),
    underDark: shot(renderer, scene, camera, dark, under),
    overlayDark: shot(renderer, scene, camera, dark, overlay),
    overlayLight: shot(renderer, scene, camera, lightBg, overlay),
    highlight: shot(renderer, scene, camera, dark, highlighted),
    cube: shot(renderer, scene, camera, dark, cube),
  };
  renderer.dispose();
  return out;
}
