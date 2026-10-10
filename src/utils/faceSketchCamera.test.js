import assert from 'node:assert/strict';
import test from 'node:test';
import { Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Vector3 } from 'three';
import { faceSketchBox, faceSketchPose } from './faceSketchCamera.js';

test('face sketch pose looks along the outward normal and frames the face', () => {
  const camera = new PerspectiveCamera(45, 390 / 700, 0.1, 2000);
  camera.position.set(80, -60, 40);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const controls = {
    target: new Vector3(0, 0, 0),
    update() { camera.lookAt(this.target); },
  };
  const mesh = new Mesh(new PlaneGeometry(10, 10), new MeshBasicMaterial());
  mesh.name = 'highlight';
  mesh.position.set(0, 0, 18);
  mesh.updateMatrixWorld(true);
  const box = faceSketchBox([mesh]);
  assert.ok(box);
  const pose = faceSketchPose({ camera, controls, box, normal: [0, 0, 1] });
  assert.ok(pose);
  const dx = pose.position[0] - pose.target[0];
  const dy = pose.position[1] - pose.target[1];
  const dz = pose.position[2] - pose.target[2];
  const len = Math.hypot(dx, dy, dz);
  assert.ok(dz / len > 0.98, `view dir ${dz / len}`);
  assert.ok(Math.hypot(pose.target[0], pose.target[1], pose.target[2] - 18) < 1);
  assert.ok(pose.position[2] > 18);
});
