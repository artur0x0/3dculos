import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxGeometry, Mesh, PerspectiveCamera, Vector3 } from 'three';
import { DEFAULT_PART_COLOR, makeDefaultPartMaterial } from './partMaterial.js';
import { fitView, meshWorldBox, unionWorldBox } from './viewCamera.js';

test('default part color is the off-white constant', () => {
  assert.equal(DEFAULT_PART_COLOR, 0xeceae4);
  const material = makeDefaultPartMaterial();
  assert.equal(material.color.getHex(), DEFAULT_PART_COLOR);
  assert.equal(material.flatShading, true);
  assert.equal(material.metalness, 0);
  assert.equal(material.userData.defaultPart, true);
  material.dispose();
});

test('one part at the origin frames the same as its geometry', () => {
  const geometry = new BoxGeometry(20, 16, 12);
  const mesh = new Mesh(geometry);
  mesh.updateWorldMatrix(true, false);
  const camA = new PerspectiveCamera(45, 1.6, 0.1, 2000);
  const camB = new PerspectiveCamera(45, 1.6, 0.1, 2000);
  assert.equal(fitView({ camera: camA, geometry }), true);
  assert.equal(fitView({ camera: camB, box: meshWorldBox(mesh) }), true);
  assert.ok(camA.position.distanceTo(camB.position) < 1e-4);
  geometry.dispose();
});

test('fit unions separated visible parts and skips a hidden one', () => {
  const near = new Mesh(new BoxGeometry(20, 20, 20));
  const far = new Mesh(new BoxGeometry(20, 20, 20));
  far.position.set(80, 0, 0);
  const hidden = new Mesh(new BoxGeometry(20, 20, 20));
  hidden.position.set(500, 0, 0);
  hidden.visible = false;
  const box = unionWorldBox([near, far, hidden]);
  assert.ok(box);
  assert.ok(box.min.x < -5 && box.max.x > 85 && box.max.x < 120);
  const camera = new PerspectiveCamera(45, 1.6, 0.1, 2000);
  assert.equal(fitView({ camera, box }), true);
  const center = box.getCenter(new Vector3());
  assert.ok(center.x > 30 && center.x < 60);
  const look = new Vector3();
  camera.getWorldDirection(look);
  const along = center.clone().sub(camera.position);
  const closest = camera.position.clone().addScaledVector(look, along.dot(look));
  assert.ok(closest.distanceTo(center) < 1e-3);
  near.geometry.dispose();
  far.geometry.dispose();
  hidden.geometry.dispose();
});

test('a sheet-hidden solid still counts, an empty mesh does not', () => {
  const mesh = new Mesh(new BoxGeometry(10, 10, 10));
  mesh.visible = false;
  mesh.userData.sheetMetalHidden = true;
  assert.ok(meshWorldBox(mesh));
  const empty = new Mesh();
  assert.equal(meshWorldBox(empty), null);
  assert.equal(unionWorldBox([empty]), null);
  mesh.geometry.dispose();
});
