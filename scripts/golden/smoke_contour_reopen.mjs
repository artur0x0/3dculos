/**
 * Reopen a contour from the feature editor.
 * No Manifold. No screenshots.
 *
 * A solveContour block comes back onto the chip with the same ids, values,
 * and names. A name is a string inside that contour, not a const, and a
 * later block that mentions it is not a dependent. An old point list restores
 * its points and is not promoted. A preset polygon stays a polygon. Each loft
 * station keeps its own name. An unchanged Confirm is byte-identical. Editing
 * a point or a dimension value rewrites that profile and leaves the solid
 * distance alone.
 */
import { contourFromRectangle } from '../../src/utils/contourSolve.js';
import { emitSolveContour, parseSolveContour } from '../../src/utils/contourScript.js';
import { enterContourState } from '../../src/utils/contourMode.js';
import { parseFeatureMarkers } from '../../src/utils/featureMarkers.js';
import {
  CUBE_BEGIN,
  CUBE_END,
  CONTOUR_EXTRUDE_BEGIN,
  CONTOUR_EXTRUDE_END,
  CONTOUR_LOFT_BEGIN,
  CONTOUR_LOFT_END,
  CONTOUR_PROFILE_BEGIN,
  CONTOUR_PROFILE_END,
} from '../../src/utils/helperPaletteSnippets.js';
import {
  applyContourEditSeed,
  confirmFeatureEdit,
  contourFieldsFromState,
  dependentToastLines,
  featureDependents,
  fieldsEqual,
  openFeatureEdit,
} from '../../src/utils/featureEdit.js';

const PLANE = '{ center: [0, 0, 0], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] }';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function featureOf(script, kind) {
  return parseFeatureMarkers(script).find((item) => item.kind === kind) || null;
}

function reopen(script, kind, entry) {
  const feature = featureOf(script, kind);
  const session = feature ? openFeatureEdit(script, feature) : { ok: false, message: 'no feature' };
  const state = applyContourEditSeed(enterContourState(entry), session);
  const fields = { ...(session.fields || {}), ...contourFieldsFromState(state) };
  return { feature, session, state, fields };
}

function namedRect(width, height, name) {
  const spec = contourFromRectangle(width, height, false);
  spec.dimensions[0].name = name;
  return spec;
}

console.log('named contour reopen');
{
  const spec = namedRect(40, 12, 'width');
  const expr = emitSolveContour(spec);
  const script = [
    CONTOUR_EXTRUDE_BEGIN,
    `const xs = makeCrossSection(${PLANE}, ${expr});`,
    'let part = placeInFrame(xs.plane, makeExtrude(xs.contours, 12), [0, 0, 0]);',
    CONTOUR_EXTRUDE_END,
    CUBE_BEGIN,
    'const box = Manifold.cube([width, 1, 1], true);',
    CUBE_END,
    '',
  ].join('\n');
  check('name is a string in the call', script.includes("name: 'width'"));
  check('no const binding', !/\bconst\s+width\b/.test(script));
  const opened = reopen(script, 'extrude', 'makeExtrude');
  check('extrude reopens', opened.session.ok, opened.session.message || '');
  const dim = opened.state?.params?.contour?.dimensions?.find((item) => item.id === 'd0');
  check('same dimension id', dim?.id === 'd0');
  check('same dimension value', dim?.value === 40, String(dim?.value));
  check('name restored on the dimension', dim?.name === 'width');
  check('name is a string', typeof dim?.name === 'string');
  check('constraint id restored', opened.state?.params?.contour?.constraints?.some((item) => item.id === 'k0'));
  check('distance stays a number', opened.session.fields?.distance === 12);
  check('no name on the extrude distance', opened.session.fields?.distanceName == null && !('name' in (opened.session.fields || {})));
  check('chip fields match the block', fieldsEqual(opened.fields, opened.session.fields));
  const same = confirmFeatureEdit(script, opened.feature, { fields: opened.fields });
  check('unchanged confirm is byte-identical', same.ok && same.changed === false && same.buffer === script, same.message || '');
  const deps = featureDependents(script, opened.feature);
  check('dimension name is not a dependent', !deps.some((item) => item.name === 'width'), JSON.stringify(deps));
  check('no toast about the name', !dependentToastLines(deps).some((line) => /\bwidth\b/.test(line)));
  const edited = JSON.parse(JSON.stringify(opened.state.params.contour));
  edited.dimensions[0].value = 45;
  const nextFields = {
    ...opened.session.fields,
    ...contourFieldsFromState({
      ...opened.state,
      params: { ...opened.state.params, contour: edited },
    }),
  };
  const wrote = confirmFeatureEdit(script, opened.feature, { fields: nextFields });
  check('value edit rewrites the call', wrote.ok && wrote.changed === true && wrote.buffer.includes('value: 45'), wrote.message || '');
  check('name survives the rewrite', wrote.buffer?.includes("name: 'width'"));
  check('extrude distance stays 12', /makeExtrude\(xs\.contours, 12\)/.test(wrote.buffer || ''));
  let message = '';
  try {
    parseSolveContour("solveContour({ points: [], lines: [], arcs: [], dimensions: [{ id: 'd0', kind: 'length', edge: 'e0', value: width }], constraints: [] })");
  } catch (err) {
    message = err.message;
  }
  check('bare identifier refused', /number or a string/.test(message), message);
}

console.log('old profiles stay unpromoted');
{
  const points = '[[0, 0], [40, 0], [40, 20], [0, 20]]';
  const script = [
    CONTOUR_PROFILE_BEGIN,
    `const xs = makeCrossSection(${PLANE}, profilePolygon(${points}));`,
    CONTOUR_PROFILE_END,
    '',
  ].join('\n');
  const opened = reopen(script, 'profile', 'crossSection');
  check('point list reopens', opened.session.ok, opened.session.message || '');
  check('points restored', JSON.stringify(opened.state?.params?.points) === '[[0,0],[40,0],[40,20],[0,20]]');
  check('point list is not a contour', opened.state?.params?.contour == null);
  check('point list fields match', fieldsEqual(opened.fields, opened.session.fields));
  const same = confirmFeatureEdit(script, opened.feature, { fields: opened.fields });
  check('point list confirm is byte-identical', same.ok && same.changed === false && same.buffer === script);
  const moved = opened.state.params.points.map((p, i) => (i === 1 ? [45, 0] : p.slice()));
  const wrote = confirmFeatureEdit(script, opened.feature, {
    fields: {
      ...opened.session.fields,
      ...contourFieldsFromState({ ...opened.state, params: { points: moved } }),
    },
  });
  check('point edit rewrites the polygon', wrote.ok && wrote.changed === true && wrote.buffer.includes('[45, 0]'), wrote.message || '');
  check('point edit does not promote', !/solveContour/.test(wrote.buffer || ''));
  check('other corners stay', wrote.buffer?.includes('[0, 0]') && wrote.buffer?.includes('[40, 20]') && wrote.buffer?.includes('[0, 20]'));

  const rect = [
    CONTOUR_PROFILE_BEGIN,
    `const xs = makeCrossSection(${PLANE}, profileRectangle(40, 20, true));`,
    CONTOUR_PROFILE_END,
    '',
  ].join('\n');
  const rectOpen = reopen(rect, 'profile', 'crossSection');
  check('rectangle stays a rectangle', rectOpen.state?.tool === 'rectangle' && rectOpen.state?.params?.contour == null);
  check('rectangle has no leftover radius', rectOpen.state?.params?.radius == null && rectOpen.fields.radius == null);
  check('rectangle fields match', fieldsEqual(rectOpen.fields, rectOpen.session.fields));
  const rectSame = confirmFeatureEdit(rect, rectOpen.feature, { fields: rectOpen.fields });
  check('rectangle confirm is byte-identical', rectSame.ok && rectSame.changed === false && rectSame.buffer === rect);

  const preset = [
    CONTOUR_PROFILE_BEGIN,
    `const xs = makeCrossSection(${PLANE}, profilePolygon('hexagon', 8));`,
    CONTOUR_PROFILE_END,
    '',
  ].join('\n');
  const presetOpen = reopen(preset, 'profile', 'crossSection');
  check('preset stays a polygon', presetOpen.session.ok && presetOpen.state?.tool === 'polygon', presetOpen.session.message || '');
  check('preset name restored', presetOpen.state?.params?.polygonPreset === 'hexagon');
  check('preset is not a contour', presetOpen.state?.params?.contour == null);
  const presetSame = confirmFeatureEdit(preset, presetOpen.feature, { fields: presetOpen.fields });
  check('preset confirm is byte-identical', presetSame.ok && presetSame.changed === false && presetSame.buffer === preset);
}

console.log('loft stations reopen alone');
{
  const wide = namedRect(40, 12, 'width');
  const deep = namedRect(20, 10, 'depth');
  const script = [
    CONTOUR_LOFT_BEGIN,
    `const a = makeCrossSection(${PLANE}, ${emitSolveContour(wide)});`,
    `const b = makeCrossSection(${PLANE}, ${emitSolveContour(deep)});`,
    'const solid = makeLoft([a, b]);',
    CONTOUR_LOFT_END,
    '',
  ].join('\n');
  const opened = reopen(script, 'loft', 'makeLoft');
  check('loft reopens', opened.session.ok, opened.session.message || '');
  const profiles = opened.state?.loft?.profiles || [];
  check('two stations', profiles.length === 2, String(profiles.length));
  const first = profiles[0]?.params?.contour?.dimensions?.find((item) => item.name === 'width');
  const second = profiles[1]?.params?.contour?.dimensions?.find((item) => item.name === 'depth');
  check('first station keeps width', first?.value === 40);
  check('second station keeps depth', second?.value === 20);
  check('depth is not on the first station', !profiles[0]?.params?.contour?.dimensions?.some((item) => item.name === 'depth'));
  check('loft fields match', fieldsEqual(opened.fields, opened.session.fields));
  const same = confirmFeatureEdit(script, opened.feature, { fields: opened.fields });
  check('loft confirm is byte-identical', same.ok && same.changed === false && same.buffer === script, same.message || '');
  const edited = JSON.parse(JSON.stringify(profiles[1].params.contour));
  edited.dimensions[0].value = 18;
  const profilesNext = profiles.map((prof, i) => (
    i === 1 ? { ...prof, params: { ...prof.params, contour: edited } } : prof
  ));
  const wrote = confirmFeatureEdit(script, opened.feature, {
    fields: {
      ...opened.session.fields,
      ...contourFieldsFromState({ ...opened.state, loft: { ...opened.state.loft, profiles: profilesNext } }),
    },
  });
  check('station edit writes depth', wrote.ok && wrote.changed === true && wrote.buffer.includes('value: 18'), wrote.message || '');
  check('width station stays', wrote.buffer?.includes("name: 'width'") && wrote.buffer?.includes('value: 40'));
  check('depth name stays on its station', wrote.buffer?.includes("name: 'depth'"));

  const circles = [
    CONTOUR_LOFT_BEGIN,
    `const a = makeCrossSection(${PLANE}, profileCircle(5, 64));`,
    `const b = makeCrossSection(${PLANE}, profileCircle(8, 64));`,
    'const solid = makeLoft([a, b]);',
    CONTOUR_LOFT_END,
    '',
  ].join('\n');
  const circleOpen = reopen(circles, 'loft', 'makeLoft');
  check('circle loft stays circles', circleOpen.state?.loft?.profiles?.every((prof) => prof.tool === 'circle' && prof.params?.contour == null));
  check('circle loft radii', circleOpen.state?.loft?.profiles?.[0]?.params?.radius === 5
    && circleOpen.state?.loft?.profiles?.[1]?.params?.radius === 8);
  check('circle loft fields match', fieldsEqual(circleOpen.fields, circleOpen.session.fields));
  const circleSame = confirmFeatureEdit(circles, circleOpen.feature, { fields: circleOpen.fields });
  check('circle loft confirm is byte-identical', circleSame.ok && circleSame.changed === false && circleSame.buffer === circles);
}

if (failed) {
  console.error(`\n${failed} reopen check(s) failed`);
  process.exit(1);
}
console.log('\ncontour reopen golden passed');
