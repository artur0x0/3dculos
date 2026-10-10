import assert from 'node:assert/strict';
import test from 'node:test';
import {
  featureSheetEditLift,
  isTextOrNumberField,
  isTouchEditDevice,
  numberFieldLabelParts,
  readFieldLabel,
  readFieldUnit,
} from './featureFieldEdit.js';

function input(type, attrs = {}) {
  return {
    tagName: 'INPUT',
    disabled: false,
    closest: () => null,
    getAttribute: (name) => (name === 'type' ? type : (attrs[name] ?? null)),
  };
}

test('text and number inputs edit; selects and sliders do not', () => {
  assert.equal(isTextOrNumberField(input('number')), true);
  assert.equal(isTextOrNumberField(input('text')), true);
  assert.equal(isTextOrNumberField(input('')), true);
  assert.equal(isTextOrNumberField({ tagName: 'TEXTAREA', disabled: false, closest: () => null, getAttribute: () => null }), true);
  assert.equal(isTextOrNumberField(input('range')), false);
  assert.equal(isTextOrNumberField(input('checkbox')), false);
  assert.equal(isTextOrNumberField({ tagName: 'SELECT', disabled: false, closest: () => null, getAttribute: () => null }), false);
  assert.equal(isTextOrNumberField(input('number', {}) && { ...input('number'), closest: () => ({}) }), false);
});

test('touch is coarse pointer or a touch point; a mouse is not', () => {
  const media = (query) => ({ matches: query === '(pointer: coarse)' });
  assert.equal(isTouchEditDevice({ matchMedia: media, navigator: { maxTouchPoints: 0 } }), true);
  assert.equal(isTouchEditDevice({ matchMedia: () => ({ matches: false }), navigator: { maxTouchPoints: 5 } }), true);
  assert.equal(isTouchEditDevice({ matchMedia: () => ({ matches: false }), navigator: { maxTouchPoints: 0 } }), false);
});

test('label prefers data-field-label, then the label, then aria-label', () => {
  assert.equal(readFieldLabel({
    getAttribute: (name) => (name === 'data-field-label' ? 'Radius' : 'nope'),
  }), 'Radius');

  const control = { id: 'wall-n' };
  const label = {
    childNodes: [
      { nodeType: 1, textContent: 'Wall', contains: () => false },
      control,
    ],
  };
  const doc = {
    querySelector: (sel) => (sel === 'label[for="wall-n"]' ? label : null),
  };
  assert.equal(readFieldLabel({
    id: 'wall-n',
    ownerDocument: doc,
    closest: () => null,
    getAttribute: () => '',
  }), 'Wall');

  assert.equal(readFieldLabel({
    id: '',
    closest: () => null,
    getAttribute: (name) => (name === 'aria-label' ? 'Distance value' : ''),
  }), 'Distance');

  assert.equal(readFieldLabel({
    id: '',
    closest: () => null,
    getAttribute: () => '',
  }), '');
});

test('unit prefers data-unit, then a following span', () => {
  assert.equal(readFieldUnit({
    getAttribute: (name) => (name === 'data-unit' ? 'mm' : ''),
  }), 'mm');
  assert.equal(readFieldUnit({
    getAttribute: () => '',
    nextElementSibling: { tagName: 'SPAN', textContent: 'mm' },
  }), 'mm');
  assert.equal(readFieldUnit({
    getAttribute: () => '',
    nextElementSibling: null,
  }), '');
});

test('number captions keep a trailing unit separate from the label', () => {
  assert.deepEqual(numberFieldLabelParts('Force N'), { label: 'Force', unit: 'N' });
  assert.deepEqual(numberFieldLabelParts('Pressure MPa'), { label: 'Pressure', unit: 'MPa' });
  assert.deepEqual(numberFieldLabelParts('E MPa'), { label: 'E', unit: 'MPa' });
  assert.deepEqual(numberFieldLabelParts('Angle °'), { label: 'Angle', unit: '°' });
  assert.deepEqual(numberFieldLabelParts('Radius'), { label: 'Radius', unit: '' });
  assert.deepEqual(numberFieldLabelParts('ν'), { label: 'ν', unit: '' });
  assert.deepEqual(numberFieldLabelParts('Distance', 'mm'), { label: 'Distance', unit: 'mm' });
});

test('edit lift sits on the visual-viewport bottom, toolbar included', () => {
  // Stubbed visualViewport: rects stay in layout space, so the visible
  // band is [offsetTop, offsetTop + height].
  assert.equal(featureSheetEditLift({
    paneBottom: 664,
    docTop: 0,
    scrollY: 0,
    vvHeight: 280,
    vvOffsetTop: 47,
  }), 664 - (47 + 280));

  // Real visual-relative rects: the document top is -offsetTop.
  assert.equal(featureSheetEditLift({
    paneBottom: 664 - 47,
    docTop: -47,
    scrollY: 0,
    vvHeight: 280,
    vvOffsetTop: 47,
  }), (664 - 47) - 280);

  // The shell is already the visual viewport.
  assert.equal(featureSheetEditLift({
    paneBottom: 280,
    docTop: -47,
    vvHeight: 280,
    vvOffsetTop: 47,
  }), 0);
  assert.equal(featureSheetEditLift({
    paneBottom: 280,
    docTop: 0,
    vvHeight: 280,
    vvOffsetTop: 47,
  }), 0);

  // Keyboard closed.
  assert.equal(featureSheetEditLift({
    paneBottom: 664,
    docTop: 0,
    vvHeight: 664,
    vvOffsetTop: 0,
  }), 0);
});
