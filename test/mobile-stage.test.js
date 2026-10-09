import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingMobileStage, linkedMobileStage } from '../src/utils/mobileStage.js';

test('a saved script stage opens Parts', () => {
  assert.equal(landingMobileStage('script'), 'parts');
  assert.equal(landingMobileStage('parts'), 'parts');
  assert.equal(landingMobileStage('cad'), 'cad');
  assert.equal(landingMobileStage(null), 'cad');
  assert.equal(landingMobileStage('nope'), 'cad');
});

test('a script deep link opens Parts and an explicit link wins', () => {
  assert.equal(linkedMobileStage('?stage=script'), 'script');
  assert.equal(linkedMobileStage('', '#script'), 'script');
  assert.equal(linkedMobileStage('', '#stage=parts'), 'parts');
  assert.equal(linkedMobileStage('?checkout=true'), null);
  assert.equal(landingMobileStage('cad', 'script'), 'parts');
  assert.equal(landingMobileStage('parts', 'cad'), 'cad');
  assert.equal(landingMobileStage('script', linkedMobileStage('?stage=script')), 'parts');
});
