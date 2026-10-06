/**
 * Which feature a failed run failed in (feature strip red border).
 *
 * The worker runs the script as `new Function(...scope, '"use strict";\n' + script)`.
 * A throw from a helper called by the script still has one frame in that
 * anonymous function: the script line that made the call. The worker maps
 * that frame to a 1-based script line (calibrated once against a probe, so
 * the engine's header lines do not matter) and sends it with the error.
 * The line is then mapped to the marked feature block that contains it.
 */
import { parseFeatureMarkers } from './featureMarkers.js';

/** Frames of the `new Function` body: V8 `<anonymous>:L:C`, Firefox `> Function:L:C`. */
const ANON_FRAME = /(?:<anonymous>|> Function):(\d+):(\d+)/;

/** Raw line of the first anonymous-function frame in `stack`, or null. */
export function anonymousFrameLine(stack) {
  const m = ANON_FRAME.exec(String(stack || ''));
  if (!m) return null;
  const line = Number(m[1]);
  return Number.isFinite(line) && line > 0 ? line : null;
}

/**
 * Engine header offset for `new Function` bodies: a throw on body line 2
 * (script line 1, after "use strict") reports at `probeLine`.
 * @returns {number|null}
 */
export function calibrateScriptLineOffset() {
  try {
    // eslint-disable-next-line no-new-func
    new Function('a', '"use strict";\nthrow new Error("probe");')();
  } catch (err) {
    const line = anonymousFrameLine(err?.stack);
    if (line != null) return line - 1;
  }
  return null;
}

/** 1-based script line of the failing call, or null when the stack has none. */
export function scriptLineFromStack(stack, offset) {
  const raw = anonymousFrameLine(stack);
  if (raw == null || !Number.isFinite(offset)) return null;
  const line = raw - offset;
  return line >= 1 ? line : null;
}

/** Character offset of the start of 1-based `line` (clamped to the script). */
export function lineStartOffset(script, line) {
  const text = String(script || '');
  let at = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return text.length;
    at = nl + 1;
  }
  return at;
}

/**
 * The marked feature that holds the failing line, or null.
 * @returns {{ id: string, kind: string, typeIndex: number, block: string }|null}
 */
export function failedFeatureFor(script, line) {
  const text = String(script || '');
  if (!text || !(Number(line) >= 1)) return null;
  const at = lineStartOffset(text, Number(line));
  const lineEnd = text.indexOf('\n', at) < 0 ? text.length : text.indexOf('\n', at);
  const hit = parseFeatureMarkers(text).find((f) => f.startOffset <= lineEnd && at < f.endOffset);
  if (!hit) return null;
  return {
    id: hit.id,
    kind: hit.kind,
    typeIndex: hit.typeIndex,
    block: text.slice(hit.startOffset, hit.endOffset),
  };
}

/**
 * Ids of strip chips to draw as failed in `script`. A chip keeps the red
 * border while its block text is the one that failed; editing that block
 * (or a run that succeeds) clears it. Another part's script does not match.
 *
 * @param {string} script   the strip's script
 * @param {{ id: string, block: string }|null} failure
 * @returns {Set<string>}
 */
export function failedFeatureIds(script, failure) {
  const out = new Set();
  if (!failure?.id || typeof failure.block !== 'string') return out;
  const text = String(script || '');
  for (const f of parseFeatureMarkers(text)) {
    if (f.id === failure.id && text.slice(f.startOffset, f.endOffset) === failure.block) out.add(f.id);
  }
  return out;
}
