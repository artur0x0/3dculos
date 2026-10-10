/**
 * Dimension Confirm writes the contour profile and nothing else.
 * It does not Auto-Run and it does not leave contour mode.
 *
 * An existing Extrude, Revolve, Loft, or Sweep block keeps its solid
 * lines. Only that block's profile expression is replaced. Loft replaces
 * the selected station. No block yet: insert the profile block.
 * An open contour stays in the session and is not emitted.
 */

import { emitSolveContour } from './contourScript.js';
import { solveContour } from './contourSolve.js';
import { specFromSolved } from './contourGesture.js';
import {
  composeContourProfile,
  contourExtrudeOwnedRegion,
  contourLoftOwnedRegion,
  contourProfileOwnedRegion,
  contourRevolveOwnedRegion,
  contourSweepOwnedRegion,
  hasContourExtrudeBlock,
  hasContourLoftBlock,
  hasContourProfileBlock,
  hasContourRevolveBlock,
  hasContourSweepBlock,
} from './contourMode.js';

function parseArgs(text, openParen) {
  if (text[openParen] !== '(') return null;
  const args = [];
  let start = openParen + 1;
  let depth = 1;
  let quote = '';
  for (let i = openParen + 1; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === '\'') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push({ start, end: i });
        return args;
      }
    } else if (c === ',' && depth === 1) {
      args.push({ start, end: i });
      start = i + 1;
    }
  }
  return null;
}

function replaceProfileArg(region, index, expr) {
  const re = /makeCrossSection\s*\(/g;
  let match;
  let n = 0;
  while ((match = re.exec(region))) {
    const openParen = match.index + match[0].length - 1;
    const args = parseArgs(region, openParen);
    if (!args || args.length < 2) continue;
    if (n === index) {
      const profile = args[1];
      const inserted = region[profile.start - 1] === ',' ? ` ${expr.trim()}` : expr.trim();
      return region.slice(0, profile.start) + inserted + region.slice(profile.end);
    }
    n += 1;
  }
  return null;
}

function replaceOwned(buffer, region, index, expr) {
  const next = replaceProfileArg(region, index, expr);
  if (!next) return null;
  const text = String(buffer || '');
  const at = text.lastIndexOf(region);
  if (at < 0) return null;
  return text.slice(0, at) + next + text.slice(at + region.length);
}

/** True when a profile or solid block is already in the script for this entry. */
export function contourBlockReady(buffer, entry, loftSelected = 0) {
  return !!slotFor(buffer, entry, loftSelected)?.region;
}

function slotFor(buffer, entry, loftSelected) {
  if (entry === 'makeExtrude' && hasContourExtrudeBlock(buffer)) {
    return { region: contourExtrudeOwnedRegion(buffer), index: 0 };
  }
  if (entry === 'makeRevolve' && hasContourRevolveBlock(buffer)) {
    return { region: contourRevolveOwnedRegion(buffer), index: 0 };
  }
  if (entry === 'makeSweep' && hasContourSweepBlock(buffer)) {
    return { region: contourSweepOwnedRegion(buffer), index: 0 };
  }
  if (entry === 'makeLoft' && hasContourLoftBlock(buffer)) {
    return {
      region: contourLoftOwnedRegion(buffer),
      index: Math.max(0, Number(loftSelected) || 0),
    };
  }
  if (hasContourProfileBlock(buffer)) {
    return { region: contourProfileOwnedRegion(buffer), index: 0 };
  }
  return null;
}

/**
 * @returns {{ ok: true, buffer: string, written: boolean, message?: string } | { ok: false, message: string }}
 */
export function writeContourProfileBlock(buffer, payload = {}) {
  const params = payload.params || {};
  const contour = params.contour;
  if (!contour) return { ok: false, message: 'No contour to save.' };
  let solved;
  try {
    solved = solveContour(contour);
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
  const spec = specFromSolved(solved);
  if (!solved.contours?.length) {
    return {
      ok: true,
      buffer: String(buffer || ''),
      written: false,
      message: 'Open contour — the dimension stays here until the contour closes.',
    };
  }
  const expr = emitSolveContour(spec);
  const slot = slotFor(buffer, payload.entry, payload.loft?.selected);
  if (slot?.region) {
    const next = replaceOwned(buffer, slot.region, slot.index, expr);
    if (next != null) return { ok: true, buffer: next, written: true };
  }
  const composed = composeContourProfile(buffer, {
    face: payload.face,
    tool: payload.tool,
    params: { ...params, contour: spec },
  });
  if (!composed.ok) return composed;
  return { ok: true, buffer: composed.buffer, written: true };
}
