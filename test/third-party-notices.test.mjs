import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const notices = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/THIRD_PARTY_NOTICES.txt'), 'utf8');

test('the shipped notice names MPL sources and does not defer to LICENSES.md', () => {
  assert.match(notices, /8118f810478e0e65a7bf2d8cecdc5e203a876e97/);
  assert.match(notices, /https:\/\/github\.com\/wildmeshing\/fTetWild/);
  assert.match(notices, /40e7900ccbd767f1f360e0eb10f0f1a6432e0993/);
  assert.match(notices, /https:\/\/github\.com\/libigl\/libigl/);
  assert.match(notices, /3147391d946bb4b6c68edd901f2add6ac1f31f8c/);
  assert.match(notices, /https:\/\/gitlab\.com\/libeigen\/eigen/);
  assert.match(notices, /scripts\/fea\/overlay\/Rational\.h/);
  assert.match(notices, /scripts\/fea\/overlay\/Logger\.cpp/);
  assert.match(notices, /scripts\/fea\/build-mesh-wasm\.mjs/);
  assert.match(notices, /is not part of the production build/);
  assert.doesNotMatch(notices, /licences are listed in packages\/surfcad-mesh\/LICENSES\.md/);
});

test('jszip is elected under MIT', () => {
  assert.match(notices, /jszip is used under the MIT licence, elected from \(MIT OR GPL-3\.0-or-later\)/);
  assert.match(notices, /three-3mf-exporter/);
  assert.match(notices, /Shipped under: MIT \(elected\)/);
  assert.doesNotMatch(notices, /GNU GENERAL PUBLIC LICENSE/);
});
