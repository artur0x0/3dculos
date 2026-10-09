import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  addPartLine,
  capThumb,
  cartChipSelector,
  cartCount,
  cartUserId,
  checkoutQueue,
  checkoutSkipNote,
  emptyCart,
  orderIntent,
  presentCartLines,
  reduceCartOps,
  removeCartLine,
  resolveCartLine,
  scriptHash,
} from '../src/utils/cart.js';
import {
  cartStorageKey,
  cartUploadedKey,
  hasCartUploaded,
  markCartUploaded,
  readCart,
  shouldMigrateCart,
  writeCart,
} from '../src/utils/cartStorage.js';
import { scriptForRow } from '../src/utils/assembly.js';

function id(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function line(n, updatedAt, extra = {}) {
  return {
    lineId: id(n),
    source: 'local',
    assemblyName: 'Bracket Box',
    partId: `part-${n}`,
    surfId: null,
    partName: `Part ${n}`,
    scriptHash: 'abc',
    thumbDataUrl: null,
    qty: 1,
    options: null,
    addedAt: '2026-06-01T00:00:00.000Z',
    updatedAt,
    ...extra,
  };
}

function memoryStorage(seed = {}) {
  const data = { ...seed };
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    _data: data,
  };
}

describe('scriptHash', () => {
  test('is stable, distinguishes scripts, and fits the route', () => {
    const cube = 'let part = Manifold.cube([10, 10, 10], true);\n';
    assert.equal(scriptHash(cube), scriptHash(cube));
    assert.notEqual(scriptHash(cube), scriptHash(`${cube}\n`));
    assert.equal(scriptHash(''), scriptHash(''));
    assert.ok(scriptHash(cube).length <= 128);
    assert.match(scriptHash(cube), /^[0-9a-f]{32}$/);
  });
});

describe('resolveCartLine', () => {
  const surf = '2026-01-02-03-04-05-0001-abcd';

  test('scriptForRow finds a part that is still here', () => {
    const doc = {
      source: 'local',
      name: 'Bracket Box',
      parts: [{ id: 'part-1', name: 'Bracket' }],
    };
    const scripts = { 'part-1': 'return part;' };
    const found = scriptForRow(doc, scripts, 'part-1');
    assert.equal(found.ok, true);
    const resolved = resolveCartLine(doc, scripts, line(1, '2026-06-02T00:00:00.000Z', {
      partId: 'part-1',
      partName: 'Bracket',
    }));
    assert.equal(resolved.missing, false);
    assert.equal(resolved.script, 'return part;');
    assert.equal(resolved.part.name, 'Bracket');
  });

  test('a missing script is flagged and the line is not deleted', () => {
    const doc = {
      source: 'local',
      name: 'Bracket Box',
      parts: [{ id: 'part-1', name: 'Bracket' }],
    };
    const resolved = resolveCartLine(doc, {}, line(1, '2026-06-02T00:00:00.000Z', { partId: 'part-1' }));
    assert.equal(resolved.missing, true);
    assert.equal(resolved.reason, 'missing');
    const cart = { version: 1, lines: [line(1, '2026-06-02T00:00:00.000Z', { partId: 'part-1' })], tombstones: [] };
    const view = presentCartLines(doc, {}, cart);
    assert.equal(view.length, 1);
    assert.equal(view[0].missing, true);
    assert.equal(view[0].lineId, id(1));
  });

  test('a git rename is found through surfId', () => {
    const doc = {
      source: 'git',
      name: 'Bracket Box',
      parts: [{ id: 'parts/Renamed.js', name: 'Renamed', surfId: surf }],
    };
    const scripts = { 'parts/Renamed.js': 'let part = 1;' };
    const resolved = resolveCartLine(doc, scripts, line(1, '2026-06-02T00:00:00.000Z', {
      source: 'git',
      partId: 'parts/Old.js',
      surfId: surf,
    }));
    assert.equal(resolved.missing, false);
    assert.equal(resolved.renamed, true);
    assert.equal(resolved.part.id, 'parts/Renamed.js');
    assert.equal(resolved.script, 'let part = 1;');
  });
});

describe('reduceCartOps', () => {
  const now = new Date('2026-06-15T12:00:00.000Z');

  test('a tombstone deletes, and leaving a line out does not', () => {
    const start = {
      version: 2,
      lines: [
        line(1, '2026-06-10T00:00:00.000Z'),
        line(2, '2026-06-10T00:00:00.000Z'),
      ],
      tombstones: [],
    };
    const removed = reduceCartOps(start, [
      { type: 'remove', lineId: id(1), deletedAt: '2026-06-12T00:00:00.000Z' },
    ], now);
    assert.deepEqual(removed.lines.map((row) => row.lineId), [id(2)]);
    assert.equal(removed.tombstones.length, 1);
    assert.equal(removed.tombstones[0].lineId, id(1));

    const replayed = reduceCartOps(removed, [
      { type: 'add', line: line(1, '2026-06-09T00:00:00.000Z', { partName: 'stale' }) },
    ], now);
    assert.equal(replayed.lines.some((row) => row.lineId === id(1)), false);

    const newer = reduceCartOps(removed, [
      { type: 'add', line: line(1, '2026-06-13T00:00:00.000Z', { partName: 'back' }) },
    ], now);
    assert.equal(newer.lines.find((row) => row.lineId === id(1)).partName, 'back');
  });

  test('an older tombstone does not drop a newer line, and a tie keeps the first put', () => {
    const start = emptyCart();
    const once = reduceCartOps(start, [
      { type: 'add', line: line(1, '2026-06-10T00:00:00.000Z', { partName: 'first' }) },
      { type: 'update', line: line(1, '2026-06-10T00:00:00.000Z', { partName: 'tie' }) },
      { type: 'remove', lineId: id(1), deletedAt: '2026-06-09T00:00:00.000Z' },
    ], now);
    assert.equal(once.lines[0].partName, 'first');
    assert.equal(once.tombstones[0].lineId, id(1));
  });
});

describe('cart storage and order rules', () => {
  test('write-through keeps the cart and the upload flag after a clear', () => {
    const storage = memoryStorage();
    const userId = 'user-1';
    writeCart(storage, userId, {
      version: 3,
      lines: [line(1, '2026-06-10T00:00:00.000Z')],
      tombstones: [],
    });
    markCartUploaded(storage, userId);
    const cleared = removeCartLine(readCart(storage, userId), id(1), new Date());
    writeCart(storage, userId, cleared);
    assert.equal(hasCartUploaded(storage, userId), true);
    assert.equal(readCart(storage, userId).lines.length, 0);
    assert.equal(readCart(storage, userId).tombstones.length, 1);
    assert.equal(cartStorageKey(userId), 'surfcad_cart:user-1');
    assert.equal(cartUploadedKey(userId), 'surfcad_cart_uploaded:user-1');
    assert.equal(shouldMigrateCart({
      serverLines: [],
      localLines: readCart(storage, userId).lines,
      uploaded: true,
    }), false);
    assert.equal(shouldMigrateCart({
      serverLines: [],
      localLines: [line(1, '2026-06-01T00:00:00.000Z')],
      uploaded: false,
    }), true);
  });

  test('the same part bumps qty, a thumb over the cap is dropped, and signed-out does not add', () => {
    const draft = line(4, '2026-06-02T00:00:00.000Z', { qty: 1, partId: 'part-4' });
    const added = addPartLine(emptyCart(), draft, new Date('2026-06-02T00:00:00.000Z'));
    const again = addPartLine(added.cart, { ...draft, lineId: id(5), qty: 1 }, new Date('2026-06-03T00:00:00.000Z'));
    assert.equal(again.ok, true);
    assert.equal(again.bumped, true);
    assert.equal(again.cart.lines.length, 1);
    assert.equal(again.cart.lines[0].qty, 2);
    assert.equal(cartCount(again.cart), 2);
    assert.equal(capThumb(`data:image/png,${'a'.repeat(24_000)}`), null);
    assert.equal(capThumb('data:image/png,aaaa'), 'data:image/png,aaaa');
    assert.equal(orderIntent({ signedIn: false }), 'login');
    assert.equal(orderIntent({ signedIn: false, pending: true }), 'wait');
    assert.equal(orderIntent({ signedIn: true }), 'add');
    assert.equal(cartUserId({ _id: 'abc' }), 'abc');
    assert.equal(cartChipSelector(390), '[data-parts-profile-chip] [data-profile-chip]');
    assert.equal(cartChipSelector(1440), '[data-profile-chip-variant="viewport"]');
    assert.equal(cartChipSelector(768), '[data-parts-profile-chip] [data-profile-chip]');
  });
});

describe('checkoutQueue', () => {
  const doc = {
    source: 'local',
    name: 'Bracket Box',
    parts: [
      { id: 'part-1', name: 'Bracket' },
      { id: 'part-2', name: 'Plate' },
    ],
  };
  const scripts = {
    'part-1': 'return 1;',
    'part-2': "return importMesh('Plate.mesh');\n",
  };

  test('skips missing and other assemblies, and quotes a changed script', () => {
    const cart = {
      version: 1,
      lines: [
        line(1, '2026-06-02T00:00:00.000Z', {
          partId: 'part-1',
          partName: 'Bracket',
          scriptHash: scriptHash('return 1;'),
          qty: 2,
        }),
        line(2, '2026-06-02T00:00:00.000Z', {
          partId: 'part-2',
          partName: 'Plate',
          scriptHash: scriptHash('old'),
          qty: 4,
        }),
        line(3, '2026-06-02T00:00:00.000Z', { partId: 'part-missing', partName: 'Gone' }),
        line(4, '2026-06-02T00:00:00.000Z', {
          partId: 'part-x',
          partName: 'Other',
          assemblyName: 'Other Box',
        }),
      ],
      tombstones: [],
    };
    const queue = checkoutQueue(doc, scripts, cart, {
      'part-2': { ok: false, error: 'Missing mesh asset: Plate.mesh' },
    });
    assert.deepEqual(queue.lines.map((row) => row.partName), ['Bracket', 'Plate']);
    assert.equal(queue.lines[0].qty, 2);
    assert.equal(queue.lines[0].script, 'return 1;');
    assert.equal(queue.lines[0].hashStale, false);
    assert.equal(queue.lines[1].hashStale, true);
    assert.equal(queue.lines[1].script, scripts['part-2']);
    assert.equal(queue.lines[1].partId, 'part-2');
    assert.equal(queue.lines[1].lineError, 'Missing mesh asset: Plate.mesh');
    assert.deepEqual(queue.skipped.map((row) => row.reason), ['missing', 'elsewhere']);
    assert.match(checkoutSkipNote(queue), /Missing parts are skipped/);
    assert.match(checkoutSkipNote(queue), /another assembly/);
  });

  test('a closed assembly checks out nothing', () => {
    const cart = {
      version: 1,
      lines: [line(1, '2026-06-02T00:00:00.000Z', { partId: 'part-1' })],
      tombstones: [],
    };
    const closed = checkoutQueue(null, {}, cart);
    assert.equal(closed.lines.length, 0);
    assert.equal(checkoutSkipNote(closed), 'Open an assembly to check out.');
  });
});
