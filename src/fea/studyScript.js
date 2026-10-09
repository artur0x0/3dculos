/**
 * Comment-only FEA study block inside a part script.
 *
 * The block is line comments, so it does not change evaluation or the
 * script's return value. It is not written to `.surf.json` (that file
 * rejects unknown keys; the study lives in the part script only).
 *
 * Marker text matches the other feature blocks (`// --- name begin ---`).
 * featureMarkers.js is what turns a marker into a chip; this module does
 * not register one.
 *
 *   // --- fea-study begin ---
 *   // @fea-study {"v":1,...}
 *   // --- fea-study end ---
 *
 * Several studies are several blocks, matched by `id`. A missing block is
 * an empty read, not an error. A block that is not valid JSON is reported
 * and left in place when a different study is saved.
 */

import { defaultStudy, studyJson, validateStudy } from './studySchema.js';

export const FEA_STUDY_BEGIN = '// --- fea-study begin ---';
export const FEA_STUDY_END = '// --- fea-study end ---';

const STUDY_TAG = '// @fea-study ';

function blockText(study) {
  return `${FEA_STUDY_BEGIN}\n${STUDY_TAG}${studyJson(study)}\n${FEA_STUDY_END}\n`;
}

/** Canonical three-line comment block, including its trailing newline. */
export function feaStudyBlock(study) {
  return blockText(defaultStudy(study));
}

function closedSpans(script) {
  const spans = [];
  const errors = [];
  let from = 0;
  while (from < script.length) {
    const start = script.indexOf(FEA_STUDY_BEGIN, from);
    if (start < 0) break;
    const endMarker = script.indexOf(FEA_STUDY_END, start + FEA_STUDY_BEGIN.length);
    if (endMarker < 0) {
      errors.push(`fea-study block at offset ${start} is missing the end marker`);
      break;
    }
    let end = endMarker + FEA_STUDY_END.length;
    if (script[end] === '\r') end += 1;
    if (script[end] === '\n') end += 1;
    spans.push({ start, end });
    from = end;
  }
  return { spans, errors };
}

function taggedLines(body) {
  return body.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => (
    line.startsWith(STUDY_TAG) || line === '// @fea-study'
  ));
}

function parseSpan(script, span) {
  const tagged = taggedLines(script.slice(span.start, span.end));
  if (tagged.length === 0) {
    return { error: `fea-study block at offset ${span.start} has no // @fea-study line` };
  }
  if (tagged.length > 1) {
    return { error: `fea-study block at offset ${span.start} has more than one // @fea-study line` };
  }
  const json = tagged[0].startsWith(STUDY_TAG) ? tagged[0].slice(STUDY_TAG.length).trim() : '';
  let raw;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { error: `fea-study block at offset ${span.start} is not valid JSON (${err.message})` };
  }
  return { raw };
}

/**
 * Every well-formed study in the script, in order.
 * `{ studies, errors }`. Never throws. A missing block is `{ studies: [], errors: [] }`.
 */
export function readFeaStudies(script) {
  const text = typeof script === 'string' ? script : '';
  const { spans, errors } = closedSpans(text);
  const studies = [];
  const seen = new Set();
  for (const span of spans) {
    const parsed = parseSpan(text, span);
    if (parsed.error) {
      errors.push(parsed.error);
      continue;
    }
    const strict = validateStudy(parsed.raw, { defaults: false });
    if (!strict.ok) {
      errors.push(`fea-study block at offset ${span.start} is invalid (${strict.errors.join('; ')})`);
      continue;
    }
    if (seen.has(strict.study.id)) {
      errors.push(`duplicate fea-study id "${strict.study.id}" at offset ${span.start}`);
    }
    seen.add(strict.study.id);
    studies.push(strict.study);
  }
  return { studies, errors };
}

/** The first valid study, or null when the script has none. */
export function readFeaStudy(script) {
  const { studies } = readFeaStudies(script);
  return studies.length ? studies[0] : null;
}

function applyEdits(text, edits) {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of ordered) {
    if (out.slice(edit.start, edit.end) === edit.text) continue;
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

function appendBlock(text, block) {
  if (!text) return block;
  if (text.endsWith('\n')) return text + block;
  return `${text}\n${block}`;
}

function sameString(script, text, out) {
  return out === text && typeof script === 'string' ? script : out;
}

/**
 * Replace the valid study blocks with `studies`. Studies already in the
 * script stay where they are; new ids are appended. An empty list removes
 * every valid block and leaves a script that had none untouched. A block
 * that does not parse is left in place.
 */
export function composeFeaStudies(script, studies = []) {
  const text = typeof script === 'string' ? script : '';
  const normalized = [];
  const incomingIds = new Set();
  for (const study of studies) {
    const next = defaultStudy(study);
    if (incomingIds.has(next.id)) {
      throw new Error(`composeFeaStudies: duplicate study id "${next.id}"`);
    }
    incomingIds.add(next.id);
    normalized.push(next);
  }
  const { spans } = closedSpans(text);
  const edits = [];
  const replaced = new Set();
  for (const span of spans) {
    const parsed = parseSpan(text, span);
    if (!Object.prototype.hasOwnProperty.call(parsed, 'raw')) continue;
    const strict = validateStudy(parsed.raw, { defaults: false });
    if (!strict.ok) continue;
    const replacement = normalized.find((study) => study.id === strict.study.id);
    if (!replacement) {
      edits.push({ start: span.start, end: span.end, text: '' });
      continue;
    }
    replaced.add(strict.study.id);
    edits.push({ start: span.start, end: span.end, text: blockText(replacement) });
  }
  let out = applyEdits(text, edits);
  for (const study of normalized) {
    if (replaced.has(study.id)) continue;
    out = appendBlock(out, blockText(study));
  }
  return sameString(script, text, out);
}

/** Insert or replace the study with this id. Other studies stay put. */
export function composeFeaStudy(script, study) {
  const next = defaultStudy(study);
  const { studies } = readFeaStudies(script);
  const kept = [];
  const seen = new Set();
  let replaced = false;
  for (const item of studies) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (item.id === next.id) {
      kept.push(next);
      replaced = true;
    } else {
      kept.push(item);
    }
  }
  if (!replaced) kept.push(next);
  return composeFeaStudies(script, kept);
}

/**
 * Remove one study, or every closed study block when `id` is omitted
 * (including a block whose JSON does not parse). A missing id returns
 * the script unchanged.
 */
export function stripFeaStudy(script, id) {
  const text = typeof script === 'string' ? script : '';
  const { spans } = closedSpans(text);
  if (!spans.length) return sameString(script, text, text);
  if (id === undefined) {
    const out = applyEdits(text, spans.map((span) => ({ start: span.start, end: span.end, text: '' })));
    return sameString(script, text, out);
  }
  const { studies } = readFeaStudies(text);
  if (!studies.some((study) => study.id === id)) return sameString(script, text, text);
  const kept = [];
  const seen = new Set();
  for (const study of studies) {
    if (study.id === id || seen.has(study.id)) continue;
    seen.add(study.id);
    kept.push(study);
  }
  return composeFeaStudies(text, kept);
}

/**
 * The script with every closed study block removed (the marker lines and
 * the newline that ends the block). Code outside the markers is unchanged.
 */
export function scriptOutsideFeaStudy(script) {
  const text = typeof script === 'string' ? script : '';
  const { spans } = closedSpans(text);
  if (!spans.length) return sameString(script, text, text);
  const out = applyEdits(text, spans.map((span) => ({ start: span.start, end: span.end, text: '' })));
  return sameString(script, text, out);
}
