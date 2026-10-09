import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  QUOTE_TTL_MS,
  addPartLine,
  capThumb,
  cartChipSelector,
  cartCount,
  cartLineIsStale,
  cartUserId,
  checkoutQueue,
  checkoutSkipNote,
  emptyCart,
  isQuoteExpired,
  makeCartDraft,
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
import { cartSyncPayload } from '../src/utils/cartSync.js';

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

  test('a line matches on part, options, and script hash', () => {
    const quoted = {
      source: 'local',
      assemblyName: 'Bracket Box',
      partId: 'part-1',
      surfId: 'surf-1',
      partName: 'Bracket',
      scriptHash: 'hash-a',
      qty: 1,
      options: { process: 'FDM', material: 'PLA', infill: 20 },
      quotedUnitPrice: 4,
      quoteId: 'q1',
      quotedAt: '2026-06-01T00:00:00.000Z',
      addedAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      lineId: id(1),
    };
    const added = addPartLine(emptyCart(), quoted);
    const otherMaterial = addPartLine(added.cart, {
      ...quoted,
      lineId: id(2),
      options: { process: 'FDM', material: 'PETG', infill: 20 },
      quoteId: 'q2',
    });
    assert.equal(otherMaterial.bumped, false);
    assert.equal(otherMaterial.cart.lines.length, 2);
    const otherHash = addPartLine(otherMaterial.cart, {
      ...quoted,
      lineId: id(3),
      scriptHash: 'hash-b',
      quoteId: 'q3',
    });
    assert.equal(otherHash.bumped, false);
    const otherInfill = addPartLine(otherHash.cart, {
      ...quoted,
      lineId: id(4),
      options: { process: 'FDM', material: 'PLA', infill: 40 },
      quoteId: 'q4',
    });
    assert.equal(otherInfill.bumped, false);
    assert.equal(otherInfill.cart.lines.length, 4);
    const again = addPartLine(otherInfill.cart, {
      ...quoted,
      lineId: id(5),
      qty: 2,
      quoteId: 'q5',
      quotedUnitPrice: 5,
      quotedAt: '2026-06-02T00:00:00.000Z',
    });
    assert.equal(again.bumped, true);
    assert.equal(again.cart.lines.length, 4);
    const bumped = again.cart.lines.find((row) => row.lineId === id(1));
    assert.equal(bumped.qty, 3);
    assert.equal(bumped.quoteId, 'q5');
    assert.equal(bumped.quotedUnitPrice, 5);
    assert.equal(bumped.quotedAt, '2026-06-02T00:00:00.000Z');
    const renamed = addPartLine(again.cart, {
      ...quoted,
      lineId: id(6),
      partId: 'part-renamed',
      quoteId: 'q6',
      quotedUnitPrice: 6,
      quotedAt: '2026-06-03T00:00:00.000Z',
    });
    assert.equal(renamed.bumped, true);
    assert.equal(renamed.cart.lines.find((row) => row.quoteId === 'q6').partId, 'part-renamed');
    const unquoted = addPartLine(emptyCart(), line(1, '2026-06-02T00:00:00.000Z', {
      partId: 'part-1',
      scriptHash: 'hash-a',
    }));
    const beside = addPartLine(unquoted.cart, { ...quoted, lineId: id(2) });
    assert.equal(beside.bumped, false);
    assert.equal(beside.cart.lines.length, 2);
  });

  test('makeCartDraft locks the quoted script and the server price', () => {
    const script = 'return 1;';
    const draft = makeCartDraft({
      doc: { source: 'local', name: 'Bracket Box' },
      part: { id: 'part-1', name: 'Bracket', surfId: 'surf-1' },
      script,
      qty: 3,
      options: { process: 'FDM', material: 'PLA', infill: 20 },
      quotedUnitPrice: 4.5,
      quoteId: 'q-new',
      quotedAt: '2026-06-01T00:00:00.000Z',
    });
    assert.equal(draft.scriptHash, scriptHash(script));
    assert.equal(draft.qty, 3);
    assert.equal(draft.options.material, 'PLA');
    assert.equal(draft.options.infill, 20);
    const stored = addPartLine(emptyCart(), draft);
    assert.equal(stored.ok, true);
    assert.equal(stored.cart.lines[0].scriptHash, scriptHash(script));
    assert.equal(stored.cart.lines[0].quotedUnitPrice, 4.5);
    assert.equal(stored.cart.lines[0].quoteId, 'q-new');
    assert.equal(stored.cart.lines[0].quotedAt, '2026-06-01T00:00:00.000Z');
  });
});

describe('cart line v3 sync', () => {
  const now = new Date('2026-06-15T12:00:00.000Z');

  test('local storage keeps a quoted line next to an old line', () => {
    assert.equal(QUOTE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
    const storage = memoryStorage();
    const quotedAt = '2026-06-10T00:00:00.000Z';
    writeCart(storage, 'user-1', {
      version: 4,
      lines: [
        line(1, '2026-06-10T00:00:00.000Z'),
        line(2, '2026-06-11T00:00:00.000Z', {
          qty: 6,
          scriptHash: 'quoted-hash',
          options: { process: 'SLS', material: 'Nylon', infill: 40 },
          quotedUnitPrice: 18.25,
          quoteId: 'quote-2',
          quotedAt,
        }),
      ],
      tombstones: [],
    });
    const stored = readCart(storage, 'user-1');
    assert.equal(stored.lines.length, 2);
    assert.equal(stored.lines[0].options, null);
    assert.equal(stored.lines[0].quotedUnitPrice, null);
    assert.equal(stored.lines[0].quoteId, null);
    assert.equal(stored.lines[0].quotedAt, null);
    assert.equal(stored.lines[1].qty, 6);
    assert.equal(stored.lines[1].scriptHash, 'quoted-hash');
    assert.equal(stored.lines[1].options.process, 'SLS');
    assert.equal(stored.lines[1].options.material, 'Nylon');
    assert.equal(stored.lines[1].options.infill, 40);
    assert.equal(stored.lines[1].quotedUnitPrice, 18.25);
    assert.equal(stored.lines[1].quoteId, 'quote-2');
    assert.equal(stored.lines[1].quotedAt, quotedAt);

    const partial = line(3, '2026-06-11T00:00:00.000Z', { quotedUnitPrice: 3 });
    writeCart(storage, 'user-1', { version: 5, lines: [partial], tombstones: [] });
    const dropped = readCart(storage, 'user-1');
    assert.equal(dropped.lines.length, 1);
    assert.equal(dropped.lines[0].lineId, id(3));
    assert.equal(dropped.lines[0].quotedUnitPrice, null);
    assert.equal(dropped.lines[0].quoteId, null);

    const payload = cartSyncPayload(stored, 4);
    assert.equal(payload.baseVersion, 4);
    assert.equal(payload.lines[1].quotedUnitPrice, 18.25);
    assert.equal(payload.lines[1].quoteId, 'quote-2');
    assert.equal(payload.lines[1].quotedAt, quotedAt);
    assert.equal(payload.lines[1].scriptHash, 'quoted-hash');
    assert.equal(payload.lines[1].options.process, 'SLS');
    assert.equal(payload.lines[1].options.material, 'Nylon');
    assert.equal(payload.lines[1].options.infill, 40);
    assert.equal(payload.lines[0].quotedUnitPrice, null);
    assert.equal(payload.lines[0].quoteId, null);
  });

  test('quoteExpired follows the 7-day TTL and does not remove the line from checkout', () => {
    const freshAt = new Date(now.getTime() - QUOTE_TTL_MS).toISOString();
    const staleAt = new Date(now.getTime() - QUOTE_TTL_MS - 1).toISOString();
    const doc = {
      source: 'local',
      name: 'Bracket Box',
      parts: [{ id: 'part-1', name: 'Bracket' }, { id: 'part-2', name: 'Plate' }],
    };
    const scripts = { 'part-1': 'return 1;', 'part-2': 'return 2;' };
    const cart = {
      version: 1,
      lines: [
        line(1, '2026-06-02T00:00:00.000Z', {
          partId: 'part-1',
          scriptHash: scriptHash('return 1;'),
          options: { process: 'FDM', material: 'PLA', infill: 20 },
          quotedUnitPrice: 5,
          quoteId: 'quote-fresh',
          quotedAt: freshAt,
        }),
        line(2, '2026-06-02T00:00:00.000Z', {
          partId: 'part-2',
          scriptHash: scriptHash('return 2;'),
          options: { process: 'FDM', material: 'PLA', infill: 20 },
          quotedUnitPrice: 5,
          quoteId: 'quote-stale',
          quotedAt: staleAt,
        }),
      ],
      tombstones: [],
    };
    assert.equal(isQuoteExpired(cart.lines[0], now), false);
    assert.equal(isQuoteExpired(cart.lines[1], now), true);
    const view = presentCartLines(doc, scripts, cart, now);
    assert.equal(view[0].quoteExpired, false);
    assert.equal(view[0].hashStale, false);
    assert.equal(view[1].quoteExpired, true);
    assert.equal(cartLineIsStale(view[0]), false);
    assert.equal(cartLineIsStale(view[1]), true);
    const queue = checkoutQueue(doc, scripts, cart);
    assert.deepEqual(queue.lines.map((row) => row.partId), ['part-1', 'part-2']);
    assert.equal(queue.skipped.length, 0);
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
