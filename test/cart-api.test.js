import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { geometryFromMesh, meshFrom3mfXml } from '../src/utils/meshMeasure.js';
import { interpretCartResponse } from '../src/utils/cartApi.js';

describe('cart API compatibility', () => {
  test('404 is local-only and shows no error', () => {
    const gone = interpretCartResponse(404);
    assert.equal(gone.localOnly, true);
    assert.equal(gone.showError, false);
    assert.equal(gone.retry, false);
    assert.equal(gone.auth, false);
  });

  test('401 asks for sign-in and does not retry', () => {
    const denied = interpretCartResponse(401);
    assert.equal(denied.auth, true);
    assert.equal(denied.showError, false);
    assert.equal(denied.retry, false);
  });

  test('other failures stay local and retry with no toast', () => {
    const failed = interpretCartResponse(500);
    assert.equal(failed.showError, false);
    assert.equal(failed.retry, true);
    assert.equal(failed.localOnly, false);
  });
});

describe('exported mesh volume', () => {
  test('a unit cube XML measures as volume 1', () => {
    const xml = `
      <model>
        <mesh>
          <vertices>
            <vertex x="0" y="0" z="0"/>
            <vertex x="1" y="0" z="0"/>
            <vertex x="1" y="1" z="0"/>
            <vertex x="0" y="1" z="0"/>
            <vertex x="0" y="0" z="1"/>
            <vertex x="1" y="0" z="1"/>
            <vertex x="1" y="1" z="1"/>
            <vertex x="0" y="1" z="1"/>
          </vertices>
          <triangles>
            <triangle v1="0" v2="2" v3="1"/>
            <triangle v1="0" v2="3" v3="2"/>
            <triangle v1="4" v2="5" v3="6"/>
            <triangle v1="4" v2="6" v3="7"/>
            <triangle v1="0" v2="1" v3="5"/>
            <triangle v1="0" v2="5" v3="4"/>
            <triangle v1="3" v2="6" v3="2"/>
            <triangle v1="3" v2="7" v3="6"/>
            <triangle v1="0" v2="4" v3="7"/>
            <triangle v1="0" v2="7" v3="3"/>
            <triangle v1="1" v2="2" v3="6"/>
            <triangle v1="1" v2="6" v3="5"/>
          </triangles>
        </mesh>
      </model>`;
    const geometry = geometryFromMesh(meshFrom3mfXml(xml));
    assert.ok(Math.abs(geometry.volume - 1) < 1e-9);
    assert.deepEqual(geometry.boundingBox, { width: 1, height: 1, depth: 1 });
  });
});
