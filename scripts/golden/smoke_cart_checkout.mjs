#!/usr/bin/env node
/**
 * Cart checkout: one order per line. The create body carries quantity and
 * the unit fields. The server is the multiplier. One modelData.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkoutQueue } from '../../src/utils/cart.js';
import { extendQuote, quoteFromGeometry } from '../../src/utils/quoteMath.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let failed = 0;
let passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

console.log('cart checkout — create body');
{
  const payment = read('src/components/order/PaymentStep.jsx');
  const quoteMath = read('src/utils/quoteMath.js');
  const price = read('backend/services/orderPrice.js');
  const orders = read('backend/routes/orders.js');
  const quoting = read('src/utils/quoting.js');
  const start = payment.indexOf('modelData: {');
  const end = payment.indexOf('shipping: {', start);
  const body = payment.slice(start, end);

  ok('create body has exactly one modelData',
    start >= 0 && (body.match(/modelData\s*:/g) || []).length === 1);
  ok('create body sends quantity',
    /quantity:\s*quoteData\.quantity/.test(body));
  ok('create body sends the unit fields through clientOrderQuote',
    /quote:\s*clientOrderQuote\(/.test(body)
    && /unitSubtotal:/.test(quoteMath)
    && /unitMaterial:/.test(quoteMath)
    && /unitMachine:/.test(quoteMath)
    && /unitGrams:/.test(quoteMath));
  ok('the server is the multiplier',
    /quoteFromGeometry\(/.test(price)
    && /quantity:\s*qty/.test(price)
    && /comparison-only/.test(price)
    && /priceOrder\(/.test(orders)
    && /return extendQuote\(/.test(quoting));
  ok('confirm payload includes quantity',
    /quantity:\s*Number\(confirmData\.order\?\.quantity\)/.test(payment));
}

console.log('\ncart checkout — line script, not the editor buffer');
{
  const app = read('src/App.jsx');
  const hook = read('src/hooks/useCart.jsx');
  const quoting = read('src/utils/quoting.js');
  const sheet = read('src/components/CartSheet.jsx');
  ok('checkout calls calculateQuote on the line script',
    /calculateQuote\(line\.script/.test(app)
    && /quantity:\s*line\.qty/.test(app)
    && /partId:\s*line\.partId/.test(app));
  ok('that path does not quote the editor buffer',
    !/viewportRef\.current\?\.calculateQuote\(line/.test(app));
  ok('auth is useAuthState',
    /useAuthState\(/.test(hook));
  ok('a paid line is removed',
    /removeLine\(lineId\)/.test(app));
  ok('importMesh is resolved from the asset cache before the worker',
    /resolvePartMeshes\(/.test(quoting)
    && /meshResolveError\(/.test(quoting)
    && /importedModels:\s*prepared\.importedModels/.test(quoting));
  ok('checkout button is wired and the stub is gone',
    /startCheckout/.test(sheet)
    && !/Checkout is coming next/.test(sheet));
}

console.log('\ncart checkout — extendQuote is the only multiplier');
{
  const once = quoteFromGeometry({
    volume: 24000,
    boundingBox: { width: 40, height: 30, depth: 20 },
    process: 'FDM',
    material: 'PLA',
    infill: 20,
    quantity: 1,
  });
  const triple = extendQuote(once, 3);
  ok('three copies is one multiply',
    triple.subtotal === Number((once.unitSubtotal * 3).toFixed(2))
    && triple.boundingBox.width === once.boundingBox.width);
  const doc = {
    source: 'local',
    name: 'Box',
    parts: [{ id: 'mesh', name: 'Mesh' }],
  };
  const queue = checkoutQueue(doc, {
    mesh: "return importMesh('Mesh.mesh');\n",
  }, {
    version: 0,
    lines: [{
      lineId: '00000000-0000-4000-8000-000000000009',
      source: 'local',
      assemblyName: 'Box',
      partId: 'mesh',
      surfId: null,
      partName: 'Mesh',
      scriptHash: 'abc',
      thumbDataUrl: null,
      qty: 2,
      options: null,
      addedAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }],
    tombstones: [],
  }, {
    mesh: { ok: false, error: 'Missing mesh asset: Mesh.mesh' },
  });
  ok('an importMesh line stays on the same quote path with its error',
    queue.lines.length === 1
    && queue.lines[0].script.includes('importMesh')
    && queue.lines[0].lineError === 'Missing mesh asset: Mesh.mesh'
    && queue.lines[0].qty === 2);
}

console.log(failed ? `\n❌ FAIL (${failed} failed, ${passed} passed)` : `\n✅ PASS (${passed})`);
process.exit(failed ? 1 : 0);
