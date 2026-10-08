/**
 * Browser half of the face-skin golden. Renders the real skin on a cube,
 * before and after, on a dark ground and a light ground.
 */
import * as THREE from 'three';
import { buildSolidGeometry } from '../../src/utils/partSolidCache.js';
import { syncFaceColorSkin } from '../../src/utils/faceColorSkin.js';

const W = 390;
const H = 520;

function sample(renderer, bg) {
  const gl = renderer.getContext();
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const br = (bg >> 16) & 255;
  const bgg = (bg >> 8) & 255;
  const bb = bg & 255;
  let red = 0;
  let rr = 0;
  let rg = 0;
  let rb = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = ((H - 1 - y) * W + x) * 4;
      const r = buf[i];
      const g = buf[i + 1];
      const b = buf[i + 2];
      if (Math.abs(r - br) < 6 && Math.abs(g - bgg) < 6 && Math.abs(b - bb) < 6) continue;
      if (r > 200 && g < 50 && b < 50) {
        red++;
        rr += r;
        rg += g;
        rb += b;
      }
    }
  }
  return {
    red,
    r: red ? rr / red : 0,
    g: red ? rg / red : 0,
    b: red ? rb / red : 0,
    png: renderer.domElement.toDataURL('image/png'),
  };
}

function frame(camera, object) {
  const box = new THREE.Box3().setFromObject(object);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const dist = sphere.radius / Math.sin((45 * Math.PI) / 360) * 1.35;
  const dir = new THREE.Vector3(0.9, -0.7, 0.85).normalize();
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  camera.up.set(0, 0, 1);
  camera.lookAt(sphere.center);
  camera.updateMatrixWorld(true);
}

function hostFrom(meshData) {
  const { geometry } = buildSolidGeometry(meshData);
  const host = new THREE.Mesh(geometry, new THREE.MeshNormalMaterial({ flatShading: true }));
  return host;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ mesh: object, surfId: string, colors: object }} payload
 */
export function renderFaceSkinShots(canvas, payload) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 2000);
  const light = new THREE.PointLight(0xffffff, 8);
  camera.add(light);
  scene.add(camera);
  const host = hostFrom(payload.mesh);
  scene.add(host);
  frame(camera, host);

  syncFaceColorSkin(host, {
    geometry: host.geometry,
    surfId: payload.surfId,
    colors: payload.colors,
    rainbow: false,
  });
  const skin = host.userData.faceColorSkin;
  const shot = (bg, withSkin) => {
    if (skin) skin.visible = !!withSkin;
    scene.background = new THREE.Color(bg);
    renderer.setClearColor(bg, 1);
    renderer.render(scene, camera);
    return sample(renderer, bg);
  };
  const beforeDark = shot(0x1e1e1e, false);
  const afterDark = shot(0x1e1e1e, true);
  const beforeLight = shot(0xf4f4f5, false);
  const afterLight = shot(0xf4f4f5, true);
  return {
    beforeDark,
    afterDark,
    beforeLight,
    afterLight,
    material: skin ? {
      type: skin.material.type,
      vertexColors: !!skin.material.vertexColors,
      toneMapped: skin.material.toneMapped,
      depthWrite: skin.material.depthWrite,
      polygonOffset: skin.material.polygonOffset,
    } : null,
  };
}
