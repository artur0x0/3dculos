/**
 * The exported 3MF is the only geometry the server prices.
 * A client volume is ignored. An unreadable mesh is rejected.
 *
 * Run: cd backend && npm install && node --test test/
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import JSZip from 'jszip';
import {
  UNMEASURABLE_PART_ERROR,
  measureExportedPart,
} from '../services/measurePart.js';
import { priceOrder } from '../services/orderPrice.js';

const CUBE_XML = `
  <model>
    <mesh>
      <vertices>
        <vertex x="0" y="0" z="0"/>
        <vertex x="10" y="0" z="0"/>
        <vertex x="10" y="10" z="0"/>
        <vertex x="0" y="10" z="0"/>
        <vertex x="0" y="0" z="10"/>
        <vertex x="10" y="0" z="10"/>
        <vertex x="10" y="10" z="10"/>
        <vertex x="0" y="10" z="10"/>
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

const FLAT_XML = `
  <model>
    <mesh>
      <vertices>
        <vertex x="0" y="0" z="0"/>
        <vertex x="1" y="0" z="0"/>
        <vertex x="0" y="1" z="0"/>
      </vertices>
      <triangles>
        <triangle v1="0" v2="1" v3="2"/>
      </triangles>
    </mesh>
  </model>`;

async function zipModel(xml) {
  const zip = new JSZip();
  zip.file('3D/3dmodel.model', xml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return buffer.toString('base64');
}

function captureErrors(t) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.error = original;
  });
  return lines;
}

async function assertRejected(t, modelData) {
  const lines = captureErrors(t);
  const measured = await measureExportedPart(modelData);
  assert.equal(measured.ok, false);
  assert.equal(measured.error, UNMEASURABLE_PART_ERROR);
  assert.equal(measured.geometry, undefined);
  assert.ok(
    lines.some((line) => line.includes('[Orders] Could not measure exported 3MF:')),
    'rejection is logged',
  );
  return measured;
}

describe('measure exported 3MF', () => {
  test('an unmeasurable mesh is rejected and logged', async (t) => {
    await assertRejected(t, { modelFile: { data: '' }, volume: 0.001 });
    await assertRejected(t, {
      modelFile: { data: Buffer.from('not a zip').toString('base64') },
      volume: 0.001,
    });
    await assertRejected(t, {
      modelFile: { data: await zipModel(FLAT_XML) },
      volume: 0.001,
      boundingBox: { width: 0.1, height: 0.1, depth: 0.1 },
    });
    const emptyZip = new JSZip();
    emptyZip.file('Metadata/note.txt', 'no model');
    const empty = await emptyZip.generateAsync({ type: 'nodebuffer' });
    await assertRejected(t, {
      modelFile: { data: empty.toString('base64') },
      volume: 0.001,
    });
  });

  test('a mesh over the vertex cap keeps its own error', async (t) => {
    const lines = captureErrors(t);
    const vertices = ['<vertices>'];
    for (let i = 0; i < 400_001; i += 1) {
      vertices.push('<vertex x="0" y="0" z="0"/>');
    }
    vertices.push('</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles>');
    const xml = `<model><mesh>${vertices.join('')}</mesh></model>`;
    const measured = await measureExportedPart({
      modelFile: { data: await zipModel(xml) },
      volume: 0.001,
    });
    assert.equal(measured.ok, false);
    assert.equal(measured.error, 'Model is too large to price');
    assert.notEqual(measured.error, UNMEASURABLE_PART_ERROR);
    assert.ok(lines.some((line) => line.includes('Model is too large to price')));
  });

  test('a tampered client volume cannot change the price', async () => {
    const measured = await measureExportedPart({
      modelFile: { data: await zipModel(CUBE_XML) },
      volume: 0.001,
      boundingBox: { width: 0.1, height: 0.1, depth: 0.1 },
    });
    assert.equal(measured.ok, true);
    assert.ok(Math.abs(measured.geometry.volume - 1000) < 1e-6);
    assert.notEqual(measured.geometry.volume, 0.001);

    const settings = {
      process: 'FDM',
      material: 'PLA',
      infill: 20,
      quantity: 2,
      shippingCost: 8,
      state: 'OR',
      clientQuote: { subtotal: 0.01, unitSubtotal: 0.01 },
    };
    const fromMesh = priceOrder({
      volume: measured.geometry.volume,
      boundingBox: measured.geometry.boundingBox,
      ...settings,
    });
    const fromClient = priceOrder({
      volume: 0.001,
      boundingBox: { width: 0.1, height: 0.1, depth: 0.1 },
      ...settings,
    });
    assert.equal(fromMesh.ok, true);
    assert.equal(fromClient.ok, true);
    assert.notEqual(fromMesh.stripeAmountCents, fromClient.stripeAmountCents);
    assert.ok(fromMesh.total > fromClient.total);
    assert.notEqual(fromMesh.quote.subtotal, 0.01);
  });
});
