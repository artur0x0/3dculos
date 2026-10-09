/**
 * Drag scheduling for the voxel preview.
 *
 * Pointer moves coalesce to one requestAnimationFrame. A newer job cancels
 * the one already running. Magnitude (and an E-only material change) scales
 * the last field. Direction and ν rebuild through the solver, warm-started
 * from the previous displacement when the grid matches.
 */

import { boundingBox } from '../deviceProfile.js';
import { fieldRange } from '../stressSample.js';
import { scaleOperator } from './multigrid.js';
import { previewResolution } from './resolution.js';

function fixtureKey(study) {
  const ids = [];
  for (const fixture of study?.fixtures || []) {
    for (const face of fixture.faces || []) {
      const id = Number(face?.faceID);
      if (Number.isInteger(id)) ids.push(id);
    }
  }
  ids.sort((a, b) => a - b);
  return ids.join(',');
}

function close(a, b) {
  return Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Shared scale if every load changed by the same factor, else null. */
export function uniformLoadScale(prev, next) {
  const a = prev?.loads || [];
  const b = next?.loads || [];
  if (a.length !== b.length || !a.length) return null;
  let scale = null;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].kind !== b[i].kind) return null;
    if (a[i].kind === 'pressure') {
      const pa = Number(a[i].pressure_MPa);
      const pb = Number(b[i].pressure_MPa);
      if (!(Math.abs(pa) > 0)) return null;
      const s = pb / pa;
      if (scale == null) scale = s;
      else if (!close(scale, s)) return null;
      continue;
    }
    const va = a[i].vector || [];
    const vb = b[i].vector || [];
    let seen = false;
    for (let c = 0; c < 3; c += 1) {
      const x = Number(va[c]) || 0;
      const y = Number(vb[c]) || 0;
      if (Math.abs(x) < 1e-8 && Math.abs(y) < 1e-8) continue;
      if (!(Math.abs(x) > 0)) return null;
      const s = y / x;
      seen = true;
      if (scale == null) scale = s;
      else if (!close(scale, s)) return null;
    }
    if (!seen) return null;
  }
  return scale;
}

function profileOf(profile) {
  return typeof profile === 'function' ? profile() : (profile || 'desktop');
}

/**
 * `solve` runs one preview (GPU in the panel, or a fake in tests).
 * `fits` is false when a 128 grid would not fit the device.
 */
export function createPreviewController({
  solve,
  onResult,
  onError,
  requestFrame,
  cancelFrame,
  profile = 'desktop',
  fits = () => true,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
  if (typeof solve !== 'function') throw new Error('Preview controller needs a solve function.');
  const frameOf = requestFrame || ((cb) => (
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16)
  ));
  const cancelOf = cancelFrame || ((id) => (
    typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id)
  ));

  let generation = 0;
  let frame = 0;
  let pending = null;
  let last = null;
  let chain = Promise.resolve();

  function resolutionFor(job) {
    const box = job.bbox || boundingBox(job.positions || []);
    const ok = job.phase === 'release' ? fits({ ...job, bbox: box }) !== false : true;
    return previewResolution({
      phase: job.phase,
      profile: profileOf(profile),
      fits: ok,
    });
  }

  function remember(result, job, resolution, fixtures, nu, E) {
    last = {
      study: job.study,
      resolution,
      fixtures,
      nu,
      E,
      nodal: result.nodal,
      u: result.u,
      grid: result.grid,
      op: result.op,
      bytes: result.bytes,
      nx: result.nx,
      ny: result.ny,
      nz: result.nz,
      padded: result.padded,
    };
  }

  function scaled(job, resolution, fixtures, nu, E, scale, gen, started) {
    if (last.E !== E && last.op) scaleOperator(last.op, E / last.E);
    const nodal = new Float32Array(last.nodal.length);
    for (let i = 0; i < nodal.length; i += 1) nodal[i] = last.nodal[i] * scale;
    const u = new Float64Array(last.u.length);
    const uScale = scale * (E > 0 ? last.E / E : 1);
    for (let i = 0; i < u.length; i += 1) u[i] = last.u[i] * uScale;
    if (gen !== generation) return null;
    const range = fieldRange(nodal);
    const result = {
      source: 'preview',
      field: 'von_mises',
      units: 'MPa',
      nodal,
      min: range.min,
      max: range.max,
      p95: range.p95,
      safetyFactor: null,
      u,
      grid: last.grid,
      op: last.op,
      iterations: 0,
      residual: 0,
      residual0: 0,
      history: [1],
      bytes: last.bytes,
      ms: now() - started,
      resolution,
      nx: last.nx,
      ny: last.ny,
      nz: last.nz,
      padded: last.padded,
      fast: true,
    };
    remember(result, job, resolution, fixtures, nu, E);
    return result;
  }

  async function execute(job, gen) {
    const started = now();
    const resolution = resolutionFor(job);
    const nu = Number(job.material?.nu);
    const E = Number(job.material?.E_MPa);
    const fixtures = fixtureKey(job.study);
    if (
      last
      && last.resolution === resolution
      && last.fixtures === fixtures
      && last.nu === nu
      && last.nodal
      && last.u
    ) {
      const scale = uniformLoadScale(last.study, job.study);
      if (scale != null && scale > 0) {
        const result = scaled(job, resolution, fixtures, nu, E, scale, gen, started);
        if (result) onResult?.(result);
        return result;
      }
    }
    const reusable = last
      && last.resolution === resolution
      && last.fixtures === fixtures
      && last.nu === nu
      && last.grid
      && last.op;
    let u0 = null;
    if (reusable && last.u) {
      if (last.E !== E && E > 0) {
        scaleOperator(last.op, E / last.E);
        const s = last.E / E;
        for (let i = 0; i < last.u.length; i += 1) last.u[i] *= s;
        last.E = E;
      }
      u0 = new Float64Array(last.u);
    }
    const result = await solve({
      ...job,
      resolution,
      grid: reusable ? last.grid : null,
      op: reusable ? last.op : null,
      u0,
      isCurrent: () => gen === generation,
    });
    if (gen !== generation || !result || result.stale) return null;
    remember(result, job, resolution, fixtures, nu, E);
    onResult?.(result);
    return result;
  }

  function schedule(job) {
    const gen = ++generation;
    const run = chain.then(() => execute(job, gen));
    chain = run.then(() => {}, () => {});
    return run;
  }

  return {
    push(job) {
      pending = job;
      if (frame) return;
      frame = frameOf(() => {
        frame = 0;
        const next = pending;
        pending = null;
        if (!next) return;
        schedule({ ...next, phase: 'drag' }).catch((err) => onError?.(err));
      });
    },
    flush(job) {
      if (frame) cancelOf(frame);
      frame = 0;
      pending = null;
      return schedule({ ...job, phase: job?.phase || 'release' }).catch((err) => {
        onError?.(err);
        return null;
      });
    },
    cancel() {
      generation += 1;
      pending = null;
      if (frame) cancelOf(frame);
      frame = 0;
    },
  };
}
