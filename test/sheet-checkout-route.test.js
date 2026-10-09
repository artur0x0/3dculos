import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CUBE_BEGIN, CUBE_END, FILLET_MODE_BEGIN, FILLET_MODE_END } from '../src/utils/helperPaletteSnippets.js';
import { sheetCheckoutRoute } from '../src/utils/sheetMetal/sheetCheckout.js';
import { sheetMetalBlock } from '../src/utils/sheetMetal/sheetMetalScript.js';

const spec = {
  v: 1,
  sku: 'ALU-090',
  material: 'Aluminum 5052',
  t: 2,
  r: 1,
  k: 0.44,
  limits: {},
  plane: 'XY',
  width: 100,
  height: 60,
  bends: [],
  tabs: [],
  holes: [],
};

function sheetOnly(extra = {}) {
  return `${sheetMetalBlock({ ...spec, ...extra })}\nreturn part;\n`;
}

describe('sheetCheckoutRoute', () => {
  test('a sheet-only part that passes DFM routes to SendCutSend', () => {
    assert.equal(sheetCheckoutRoute(sheetOnly()), 'scs');
    assert.equal(sheetCheckoutRoute(`// note\n${sheetOnly()}`), 'scs');
  });

  test('a soft warning still routes to SendCutSend', () => {
    const warned = sheetOnly({
      tabs: [{ id: 't1', panel: 'base', edge: 'u+', width: 0.4, depth: 10, centered: true }],
    });
    assert.equal(sheetCheckoutRoute(warned), 'scs');
  });

  test('an extra feature marker routes to the quote', () => {
    const fillet = `${FILLET_MODE_BEGIN}\n// fillet\n${FILLET_MODE_END}\n`;
    const cube = `${CUBE_BEGIN}\nlet part = cube([20, 20, 20]);\n${CUBE_END}\n`;
    assert.equal(sheetCheckoutRoute(`${fillet}${sheetOnly()}`), 'quote');
    assert.equal(sheetCheckoutRoute(`${cube}${sheetMetalBlock(spec, { union: true })}\nreturn part;\n`), 'quote');
  });

  test('part.add onto other geometry routes to the quote', () => {
    assert.equal(sheetCheckoutRoute(`${sheetMetalBlock(spec, { union: true })}\nreturn part;\n`), 'quote');
  });

  test('code outside the sheet block routes to the quote', () => {
    const extras = sheetOnly().replace('return part;', 'part = part.translate([1, 0, 0]);\nreturn part;');
    assert.equal(sheetCheckoutRoute(extras), 'quote');
  });

  test('a hard DFM fail routes to the quote', () => {
    const tiny = sheetOnly({
      limits: { minHole: 1 },
      holes: [{ id: 'h1', panel: 'base', u: 0, v: 0, d: 0.2 }],
    });
    assert.equal(sheetCheckoutRoute(tiny), 'quote');
    const huge = sheetOnly({
      width: 5000,
      height: 100,
      limits: { maxPart: [200, 200] },
    });
    assert.equal(sheetCheckoutRoute(huge), 'quote');
  });

  test('an unreadable spec or a script with no sheet block routes to the quote', () => {
    assert.equal(sheetCheckoutRoute('return part;\n'), 'quote');
    assert.equal(sheetCheckoutRoute(''), 'quote');
    assert.equal(sheetCheckoutRoute(null), 'quote');
    const broken = sheetOnly().replace(/const sheetSpec = \{.*\};/, 'const sheetSpec = {;');
    assert.equal(sheetCheckoutRoute(broken), 'quote');
  });
});
