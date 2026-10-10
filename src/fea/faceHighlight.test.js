import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import {
  FEA_FACE_HIGHLIGHT_NAME,
  createFaceHighlightMesh,
  disposeHighlightObject,
  faceHighlightTargets,
  hostForHighlight,
  reconcileFaceHighlights,
  syncFeaFaceHighlights,
} from './faceHighlight.js';

function fakeMesh(id) {
  const mesh = {
    uuid: id,
    geometry: { uuid: `${id}-geom` },
    children: [],
    add(child) {
      child.parent = mesh;
      this.children.push(child);
    },
    remove(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      if (child.parent === mesh) child.parent = null;
    },
  };
  return mesh;
}

function fakeOverlay(id) {
  return {
    id,
    name: '',
    parent: null,
    userData: {},
    geometry: { disposed: 0, dispose() { this.disposed += 1; } },
    material: { disposed: 0, dispose() { this.disposed += 1; } },
    children: [],
    raycast: null,
    frustumCulled: true,
  };
}

test('targets key one overlay per fixture or load face', () => {
  const targets = faceHighlightTargets({
    fixtures: [{ faces: [{ part: 'a' }, { part: 'b' }] }],
    loads: [{ faces: [{ part: 'b' }] }, { faces: [{}] }],
  });
  assert.deepEqual(targets.map((row) => row.key), [
    'fixture:0:0',
    'fixture:0:1',
    'load:0:0',
    'load:1:0',
  ]);
  assert.equal(targets[0].partId, 'a');
  assert.equal(targets[3].partId, '');
  assert.deepEqual(faceHighlightTargets(null), []);
});

test('a part id selects that host, and a part-scope face uses the active solid', () => {
  const active = { id: 'a', active: true, mesh: {} };
  const other = { id: 'b', active: false, mesh: {} };
  assert.equal(hostForHighlight([active, other], { partId: 'b' }), other);
  assert.equal(hostForHighlight([active, other], { partId: '' }), active);
  assert.equal(hostForHighlight([other, { id: 'c', mesh: {} }], { partId: '' }), null);
  assert.equal(hostForHighlight([other], { partId: '' }), other);
  assert.equal(hostForHighlight([active], { partId: 'missing' }), null);
});

test('reconcile keeps a matching key and disposes one that left', () => {
  const host = fakeMesh('part');
  const kept = fakeOverlay('kept');
  const dropped = fakeOverlay('dropped');
  host.add(kept);
  host.add(dropped);
  const overlays = new Map([
    ['fixture:0:0', { signature: 'same', hostMesh: host, mesh: kept }],
    ['load:0:0', { signature: 'old', hostMesh: host, mesh: dropped }],
  ]);
  let created = 0;
  const result = reconcileFaceHighlights(overlays, [
    { key: 'fixture:0:0', signature: 'same', hostMesh: host, create: () => { created += 1; return fakeOverlay('new'); } },
    { key: 'fixture:0:0', signature: 'dup', hostMesh: host, create: () => { created += 1; return fakeOverlay('dup'); } },
  ], {
    dispose: disposeHighlightObject,
    attach: (mesh, spec) => spec.hostMesh.add(mesh),
  });
  assert.equal(created, 0);
  assert.deepEqual(result.kept, ['fixture:0:0']);
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.removed, ['load:0:0']);
  assert.equal(result.overlays.get('fixture:0:0').mesh, kept);
  assert.equal(dropped.parent, null);
  assert.equal(dropped.geometry.disposed, 1);
  assert.equal(dropped.material.disposed, 1);
  assert.equal(kept.geometry.disposed, 0);
  assert.deepEqual(host.children, [kept]);
});

test('a signature change replaces the mesh and disposes the old geometry', () => {
  const host = fakeMesh('part');
  const old = fakeOverlay('old');
  const edge = fakeOverlay('edge');
  old.children = [edge];
  host.add(old);
  const overlays = new Map([
    ['fixture:0:0', { signature: 'before', hostMesh: host, mesh: old }],
  ]);
  const replacement = fakeOverlay('next');
  const result = reconcileFaceHighlights(overlays, [{
    key: 'fixture:0:0',
    signature: 'after',
    hostMesh: host,
    create: () => replacement,
  }], {
    dispose: disposeHighlightObject,
    attach: (mesh, spec) => spec.hostMesh.add(mesh),
  });
  assert.equal(old.geometry.disposed, 1);
  assert.equal(old.material.disposed, 1);
  assert.equal(edge.geometry.disposed, 1);
  assert.equal(edge.material.disposed, 1);
  assert.equal(result.overlays.get('fixture:0:0').mesh, replacement);
  assert.equal(replacement.parent, host);
  assert.equal(replacement.name, FEA_FACE_HIGHLIGHT_NAME);
  assert.equal(replacement.userData.feaHighlightKey, 'fixture:0:0');
  assert.deepEqual(result.created, ['fixture:0:0']);
});

test('sync parents each face to its part and a second pass does not stack', () => {
  const partA = fakeMesh('a');
  const partB = fakeMesh('b');
  const contact = fakeOverlay('contact');
  contact.name = 'fea-contact';
  partA.add(contact);
  const hosts = [
    { id: 'a', active: true, mesh: partA },
    { id: 'b', active: false, mesh: partB },
  ];
  const study = {
    fixtures: [{ faces: [{ part: 'a' }] }, { faces: [{ part: 'a' }] }],
    loads: [{ faces: [{ part: 'b' }] }],
  };
  const options = {
    resolveTriangles: (host) => (host.id === 'b' ? [4] : [1, 2]),
    createMesh: (_host, _triangles, target) => fakeOverlay(target.key),
  };
  const first = syncFeaFaceHighlights(new Map(), study, hosts, options);
  assert.deepEqual(first.created, ['fixture:0:0', 'fixture:1:0', 'load:0:0']);
  assert.equal(partA.children.filter((child) => child.name === FEA_FACE_HIGHLIGHT_NAME).length, 2);
  assert.equal(partB.children.filter((child) => child.name === FEA_FACE_HIGHLIGHT_NAME).length, 1);
  assert.equal(contact.parent, partA);
  assert.equal(contact.geometry.disposed, 0);

  const keptLoad = first.overlays.get('load:0:0').mesh;
  const second = syncFeaFaceHighlights(first.overlays, study, hosts, options);
  assert.deepEqual(second.created, []);
  assert.equal(second.kept.length, 3);
  assert.equal(second.overlays.get('load:0:0').mesh, keptLoad);
  assert.equal(partA.children.filter((child) => child.name === FEA_FACE_HIGHLIGHT_NAME).length, 2);

  const withoutLoad = {
    fixtures: study.fixtures,
    loads: [],
  };
  const third = syncFeaFaceHighlights(second.overlays, withoutLoad, hosts, options);
  assert.deepEqual(third.removed, ['load:0:0']);
  assert.equal(keptLoad.parent, null);
  assert.equal(keptLoad.geometry.disposed, 1);
  assert.equal(partB.children.length, 0);
  assert.equal(third.overlays.size, 2);
  assert.equal(contact.parent, partA);
  assert.equal(contact.geometry.disposed, 0);

  const cleared = syncFeaFaceHighlights(third.overlays, null, hosts, options);
  assert.equal(cleared.overlays.size, 0);
  assert.equal(partA.children.filter((child) => child.name === FEA_FACE_HIGHLIGHT_NAME).length, 0);
  assert.equal(contact.parent, partA);
});

test('a built overlay is disposed with its outline and leaves the contact skin', () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 0, 0,
    10, 0, 0,
    0, 10, 0,
  ]), 3));
  geometry.setIndex([0, 1, 2]);
  const hostMesh = new Mesh(geometry, new MeshBasicMaterial());
  const contactGeometry = new BufferGeometry();
  const contact = new Mesh(contactGeometry, new MeshBasicMaterial());
  contact.name = 'fea-contact';
  hostMesh.add(contact);
  let contactDisposed = 0;
  const contactDispose = contactGeometry.dispose.bind(contactGeometry);
  contactGeometry.dispose = () => {
    contactDisposed += 1;
    contactDispose();
  };

  const hosts = [{ id: 'left', active: true, mesh: hostMesh }];
  const other = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
  hosts.push({ id: 'right', active: false, mesh: other });
  const study = {
    fixtures: [{ faces: [{ part: 'left' }] }],
    loads: [{ faces: [{ part: 'right' }] }],
  };
  const options = { resolveTriangles: () => [0] };
  const synced = syncFeaFaceHighlights(new Map(), study, hosts, options);
  assert.equal(synced.overlays.size, 1);
  const record = synced.overlays.get('fixture:0:0');
  assert.equal(record.mesh.parent, hostMesh);
  assert.equal(record.mesh.name, FEA_FACE_HIGHLIGHT_NAME);
  assert.equal(other.children.length, 0);
  const direct = createFaceHighlightMesh(geometry, [0]);
  assert.equal(direct.name, FEA_FACE_HIGHLIGHT_NAME);
  assert.ok(direct.children.some((child) => child.name === `${FEA_FACE_HIGHLIGHT_NAME}-edge`));

  const fillGeometry = record.mesh.geometry;
  const fillMaterial = record.mesh.material;
  const edge = record.mesh.children[0];
  let fillG = 0;
  let fillM = 0;
  let edgeG = 0;
  let edgeM = 0;
  const fillGDispose = fillGeometry.dispose.bind(fillGeometry);
  const fillMDispose = fillMaterial.dispose.bind(fillMaterial);
  fillGeometry.dispose = () => { fillG += 1; fillGDispose(); };
  fillMaterial.dispose = () => { fillM += 1; fillMDispose(); };
  const edgeGDispose = edge.geometry.dispose.bind(edge.geometry);
  const edgeMDispose = edge.material.dispose.bind(edge.material);
  edge.geometry.dispose = () => { edgeG += 1; edgeGDispose(); };
  edge.material.dispose = () => { edgeM += 1; edgeMDispose(); };

  const again = syncFeaFaceHighlights(synced.overlays, study, hosts, options);
  assert.equal(again.overlays.get('fixture:0:0').mesh, record.mesh);
  assert.equal(hostMesh.children.filter((child) => child.name === FEA_FACE_HIGHLIGHT_NAME).length, 1);

  const cleared = syncFeaFaceHighlights(again.overlays, { fixtures: [], loads: [] }, hosts, options);
  assert.equal(cleared.overlays.size, 0);
  assert.equal(record.mesh.parent, null);
  assert.equal(fillG, 1);
  assert.equal(fillM, 1);
  assert.equal(edgeG, 1);
  assert.equal(edgeM, 1);
  assert.equal(contactDisposed, 0);
  assert.equal(contact.parent, hostMesh);
  disposeHighlightObject(direct);
});
