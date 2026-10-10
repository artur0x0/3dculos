import assert from 'node:assert/strict';
import test from 'node:test';
import { plusTagsToHide } from './contourTagPlace.js';

function box(left, top, right, bottom) {
  return { left, top, right, bottom };
}

function item(id, flags, rect) {
  return { id, plus: !!flags.plus, chip: !!flags.chip, box: rect };
}

test('a plus inside a dimension chip is hidden', () => {
  const hide = plusTagsToHide([
    item('d0', { chip: true }, box(0, 0, 80, 44)),
    item('k0', { plus: true }, box(20, 4, 64, 48)),
  ]);
  assert.deepEqual([...hide], ['k0']);
});

test('a plus clear of the chip stays', () => {
  const hide = plusTagsToHide([
    item('d0', { chip: true }, box(0, 0, 80, 44)),
    item('k0', { plus: true }, box(200, 200, 244, 244)),
  ]);
  assert.equal(hide.size, 0);
});

test('two pluses on the same anchor collapse to the first', () => {
  const hide = plusTagsToHide([
    item('k0', { plus: true }, box(10, 10, 54, 54)),
    item('k1', { plus: true }, box(10, 10, 54, 54)),
  ]);
  assert.deepEqual([...hide], ['k1']);
});

test('a plus on a chip and a second plus on that plus both hide', () => {
  const hide = plusTagsToHide([
    item('d0', { chip: true }, box(0, 0, 80, 44)),
    item('k0', { plus: true }, box(10, 0, 54, 44)),
    item('k1', { plus: true }, box(12, 2, 56, 46)),
  ]);
  assert.equal(hide.has('k0'), true);
  assert.equal(hide.has('k1'), true);
});

test('a plus that only touches a chip stays', () => {
  const hide = plusTagsToHide([
    item('d0', { chip: true }, box(0, 0, 44, 44)),
    item('k0', { plus: true }, box(44, 0, 88, 44)),
  ]);
  assert.equal(hide.size, 0);
});

test('a horizontal icon does not hide a nearby plus', () => {
  const hide = plusTagsToHide([
    item('kH', {}, box(0, 0, 44, 44)),
    item('k0', { plus: true }, box(0, 0, 44, 44)),
  ]);
  assert.equal(hide.size, 0);
});
