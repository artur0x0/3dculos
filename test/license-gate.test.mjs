import assert from 'node:assert/strict';
import test from 'node:test';
import { licenseExpression, shipmentAllowed } from '../scripts/ci/check-npm-licenses.mjs';

test('permissive production licenses ship', () => {
  for (const expression of [
    'MIT',
    'Apache-2.0',
    'BSD-3-Clause',
    'ISC',
    '(MIT AND Zlib)',
    '(MIT OR Apache-2.0)',
    '((MIT OR Apache-2.0) AND ISC)',
  ]) {
    assert.equal(shipmentAllowed(expression).ok, true, expression);
  }
});

test('GPL, AGPL, and LGPL do not ship', () => {
  for (const expression of [
    'GPL-2.0-only',
    'GPL-2.0-or-later',
    'GPL-3.0-only',
    'GPL-3.0-or-later',
    'GPL-2.0+',
    'AGPL-3.0-only',
    'LGPL-2.1-only',
    'LGPL-2.1-or-later',
    'LGPL-3.0-or-later',
    '(GPL-2.0-only OR GPL-3.0-only)',
    '(MIT AND LGPL-2.1-only)',
    'GPL-3.0-only WITH Autoconf-exception-3.0',
    'GNU General Public License v3',
    'GNU Lesser General Public License v2.1',
    'GNU Affero General Public License v3',
  ]) {
    assert.equal(shipmentAllowed(expression).ok, false, expression);
  }
});

test('MIT OR GPL is allowed because MIT can be elected', () => {
  const decision = shipmentAllowed('(MIT OR GPL-3.0-or-later)');
  assert.equal(decision.ok, true);
});

test('non-commercial licences do not ship', () => {
  for (const expression of [
    'CC-BY-NC-4.0',
    'CC-BY-NC',
    'CC-BY-NC-SA-4.0',
    'CC-BY-NC-ND-3.0',
    'PolyForm-Noncommercial-1.0.0',
    'Commons-Clause',
    'Commons Clause',
    'Creative Commons Attribution-NonCommercial 4.0',
    '(MIT AND CC-BY-NC-4.0)',
    '(CC-BY-NC-4.0 OR PolyForm-Noncommercial-1.0.0)',
  ]) {
    assert.equal(shipmentAllowed(expression).ok, false, expression);
  }
});

test('a permissive alternative to a non-commercial licence can be elected', () => {
  assert.equal(shipmentAllowed('(MIT OR CC-BY-NC-4.0)').ok, true);
  assert.equal(shipmentAllowed('(MIT OR Commons-Clause)').ok, true);
  assert.equal(shipmentAllowed('CC-BY-3.0').ok, true);
  assert.equal(shipmentAllowed('CC-BY-SA-4.0').ok, true);
});

test('a missing license field fails closed', () => {
  assert.equal(shipmentAllowed('').ok, false);
  assert.equal(shipmentAllowed('   ').ok, false);
});

test('legacy licenses arrays are treated as a choice', () => {
  assert.equal(licenseExpression({ licenses: [{ type: 'MIT' }, { type: 'GPL-3.0-only' }] }), 'MIT OR GPL-3.0-only');
  assert.equal(shipmentAllowed(licenseExpression({ licenses: [{ type: 'MIT' }, { type: 'GPL-3.0-only' }] })).ok, true);
  assert.equal(shipmentAllowed(licenseExpression({ license: { type: 'LGPL-2.1-only' } })).ok, false);
});
