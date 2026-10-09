/**
 * Browser half of the face-skin golden. Renders the real skin on a cube,
 * before and after, on a dark ground and a light ground, plus a face-on
 * swatch check and a whole-body light/dark check.
 */
import * as THREE from 'three';
import { buildSolidGeometry } from '../../src/utils/partSolidCache.js';
import { syncFaceColorSkin } from '../../src/utils/faceColorSkin.js';
import { makeDefaultPartMaterial } from '../../src/utils/partMaterial.js';

const W = 390;
const H = 520;

function bufferSize(renderer) {
  const gl = renderer.getContext();
  return { w: gl.drawingBufferWidth, h: gl.drawingBufferHeight };
}

function sample(renderer, bg) {
  const { w, h } = bufferSize(renderer);
  const gl = renderer.getContext();
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const br = (bg >> 16) & 255;
  const bgg = (bg >> 8) & 255;
  const bb = bg & 255;
  let red = 0;
  let rr = 0;
  let rg = 0;
  let rb = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((h - 1 - y) * w + x) * 4;
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

function readBuffer(renderer) {
  const { w, h } = bufferSize(renderer);
  const gl = renderer.getContext();
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return { buf, w, h };
}

function place(camera, object, dir, up) {
  const box = new THREE.Box3().setFromObject(object);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const dist = sphere.radius / Math.sin((45 * Math.PI) / 360) * 1.35;
  camera.position.copy(sphere.center).addScaledVector(dir.clone().normalize(), dist);
  camera.up.copy(up);
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return sphere.center;
}

function project(camera, point, w, h) {
  const v = point.clone().project(camera);
  return {
    x: Math.round((v.x * 0.5 + 0.5) * w),
    y: Math.round((-v.y * 0.5 + 0.5) * h),
  };
}

function windowSample(frame, cx, cy, rad) {
  const { buf, w, h } = frame;
  let n = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let stripe = 0;
  let stripeN = 0;
  const px = (x, y) => {
    const i = ((h - 1 - y) * w + x) * 4;
    return [buf[i], buf[i + 1], buf[i + 2]];
  };
  for (let y = cy - rad; y <= cy + rad; y++) {
    for (let x = cx - rad; x <= cx + rad; x++) {
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const p = px(x, y);
      r += p[0];
      g += p[1];
      b += p[2];
      n++;
      const right = px(x + 1, y);
      stripe += Math.abs(p[0] - right[0]) + Math.abs(p[1] - right[1]) + Math.abs(p[2] - right[2]);
      stripeN++;
    }
  }
  return {
    r: n ? r / n : 0,
    g: n ? g / n : 0,
    b: n ? b / n : 0,
    n,
    stripe: stripeN ? stripe / stripeN : 99,
  };
}

function hostFrom(meshData) {
  const { geometry } = buildSolidGeometry(meshData);
  const host = new THREE.Mesh(geometry, makeDefaultPartMaterial());
  return host;
}

function materialInfo(skin) {
  if (!skin) return null;
  const m = skin.material;
  return {
    type: m.type,
    vertexColors: !!m.vertexColors,
    toneMapped: m.toneMapped,
    depthWrite: m.depthWrite,
    depthTest: m.depthTest,
    polygonOffset: m.polygonOffset,
    polygonOffsetFactor: m.polygonOffsetFactor,
    polygonOffsetUnits: m.polygonOffsetUnits,
    metalness: m.metalness,
    roughness: m.roughness,
    flatShading: !!m.flatShading,
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ mesh: object, surfId: string, colors: object }} payload
 */
export function renderFaceSkinShots(canvas, payload) {
  const pixelRatio = Number(payload.pixelRatio) > 0 ? Number(payload.pixelRatio) : 1;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(W, H, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 2000);
  // Same camera point light as the viewport (intensity 1, decay 2). At a
  // fitted view it contributes nothing; the skin's own headlight does.
  const light = new THREE.PointLight(0xffffff, 1);
  camera.add(light);
  scene.add(camera);
  const host = hostFrom(payload.mesh);
  scene.add(host);

  const paint = (colors) => {
    syncFaceColorSkin(host, {
      geometry: host.geometry,
      surfId: payload.surfId,
      colors,
      rainbow: false,
    });
    return host.userData.faceColorSkin;
  };

  const threeQuarter = new THREE.Vector3(0.9, -0.7, 0.85);
  place(camera, host, threeQuarter, new THREE.Vector3(0, 0, 1));
  const skin = paint(payload.colors);
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

  const faceOn = (hex) => {
    const key = payload.colors?.[payload.surfId]?.faces?.[0]?.key;
    const colors = { [payload.surfId]: { faces: [{ color: hex, key }] } };
    paint(colors);
    const center = place(camera, host, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
    scene.background = new THREE.Color(0x1e1e1e);
    renderer.setClearColor(0x1e1e1e, 1);
    renderer.render(scene, camera);
    const frame = readBuffer(renderer);
    const face = center.clone();
    face.z += 6;
    const px = project(camera, face, frame.w, frame.h);
    const win = windowSample(frame, px.x, px.y, Math.round(8 * pixelRatio));
    return { ...win, x: px.x, y: px.y, png: renderer.domElement.toDataURL('image/png') };
  };
  const faceOnRed = faceOn('#ff0000');
  const faceOnMid = faceOn('#2244aa');

  paint({ [payload.surfId]: { part: '#ff0000' } });
  place(camera, host, new THREE.Vector3(1.15, -0.28, 0.42), new THREE.Vector3(0, 0, 1));
  scene.background = new THREE.Color(0x1e1e1e);
  renderer.setClearColor(0x1e1e1e, 1);
  renderer.render(scene, camera);
  const bodyFrame = readBuffer(renderer);
  const brightPx = project(camera, new THREE.Vector3(10, 0, 0), bodyFrame.w, bodyFrame.h);
  const side = project(camera, new THREE.Vector3(0, -8, 0), bodyFrame.w, bodyFrame.h);
  const rad = Math.round(6 * pixelRatio);
  const bright = windowSample(bodyFrame, brightPx.x, brightPx.y, rad);
  const dark = windowSample(bodyFrame, side.x, side.y, rad);
  const body = {
    bright,
    dark,
    png: renderer.domElement.toDataURL('image/png'),
  };

  return {
    beforeDark,
    afterDark,
    beforeLight,
    afterLight,
    faceOnRed,
    faceOnMid,
    body,
    material: materialInfo(host.userData.faceColorSkin),
    buffer: bufferSize(renderer),
  };
}
