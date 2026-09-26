/**
 * Slice C — fillet kernel spike (hard-edge path).
 *
 * Production Accept still uses the #45–#46 dihedral sweep for every class.
 * Easy stays that stack (#50). This module records the spike comparison and
 * the recommended hard-path routing for a follow-up PR — it is NOT wired into
 * composeFilletCommit / filletAlongPath.
 *
 * Measured on the box WASM worker (2026-09-25), cube 40×30×20 edge r=3 and a
 * circle→square hull stand-in for loft generators:
 *   - dihedral sweep (current): box volume error ~0.3%; ~50ms on easy edge
 *   - naive sphere-hull along bisector: over-removes ~12× analytic on box —
 *     not a rolling-ball fillet
 *   - filletEdges planar (parallelepiped − cylinder): box volume exact; fails
 *     loud on curved-adjacent loft generators ("curved-face fillet not
 *     supported")
 *   - per-segment filletEdges try/catch on loft gens: skips most segments;
 *     not a quality win
 *
 * Manifold CrossSection has 2D offset; bundled Manifold solid has no
 * offset()/minkowski (shell uses corner-sphere hull). Face-offset pair-blend
 * in 3D is therefore not a drop-in.
 */

/** @typedef {'sweep-dihedral' | 'rolling-ball-segment' | 'face-offset' | 'sphere-hull' | 'adaptive-multipass'} FilletKernelId */

export const FILLET_KERNEL_EASY = 'sweep-dihedral';

/** Recommended production hard path after this spike. */
export const FILLET_KERNEL_HARD_RECOMMENDED = 'rolling-ball-segment';

/**
 * Feature flag for a future hard-class-only trial.
 * Keep false in production until a follow-up PR wires Accept.
 */
export const FILLET_HARD_KERNEL_TRIAL = false;

export const FILLET_KERNEL_CANDIDATES = Object.freeze([
  {
    id: 'sphere-hull',
    title: 'Rolling-ball / sphere (disk) boolean along the edge',
    feasible: 'partial',
    note:
      'Manifold.sphere + hull/union along the angle bisector is easy in WASM, '
      + 'but a naive sausage hull massively over-cuts (box test ~12× analytic). '
      + 'A true rolling-ball needs the parallelepiped−cylinder (or disk-sweep) '
      + 'construction already used by filletEdges, sampled per segment.',
  },
  {
    id: 'face-offset',
    title: 'Face-offset / pair-blend between adjacent faces',
    feasible: 'blocked',
    note:
      'Bundled Manifold has no solid offset()/minkowski. CrossSection.offset is '
      + '2D-only and helps planar easy edges we already handle. Non-planar loft '
      + 'walls would need custom offset surfaces — multi-slice effort.',
  },
  {
    id: 'hybrid',
    title: 'Hybrid: easy = dihedral sweep; hard = new kernel',
    feasible: 'yes',
    note:
      'Matches #50 classifyFilletEdges. Easy goldens stay on sweep. Hard routes '
      + 'to segment-wise rolling-ball (filletEdges-style cutters + #49 coherent '
      + 'segments, with curved-face relaxation for generator walls).',
  },
  {
    id: 'adaptive-multipass',
    title: 'Adaptive / multi-pass sweep',
    feasible: 'weak',
    note:
      'More booleans on mobile without fixing variable-dihedral frame error. '
      + 'No clear win over hybrid + segment rolling-ball in this spike.',
  },
]);

/**
 * Pick the kernel id for a fillet class. Easy always stays the current sweep.
 * Hard returns the recommended follow-up id when the trial flag is on;
 * otherwise still reports the recommendation without changing callers.
 *
 * @param {'easy'|'hard'|'empty'|string|null|undefined} klass
 * @param {{ trial?: boolean }} [opts]
 * @returns {{ kernel: FilletKernelId, trial: boolean, reason: string }}
 */
export function pickFilletKernelForClass(klass, opts = {}) {
  const trial = opts.trial != null ? !!opts.trial : FILLET_HARD_KERNEL_TRIAL;
  if (klass !== 'hard') {
    return {
      kernel: FILLET_KERNEL_EASY,
      trial: false,
      reason: 'easy path stays #45–#46 dihedral sweep',
    };
  }
  return {
    kernel: FILLET_KERNEL_HARD_RECOMMENDED,
    trial,
    reason: trial
      ? 'hard-class trial: segment rolling-ball (not wired to Accept in Slice C)'
      : 'hard-class recommendation: segment rolling-ball in a follow-up PR',
  };
}

/**
 * Effort note for Product / PR body.
 * @returns {{ effort: '1-follow-up-PR'|'multi-slice', summary: string }}
 */
export function hardFilletKernelEffort() {
  return {
    effort: '1-follow-up-PR',
    summary:
      'Wire hard-class-only Accept to segment-wise rolling-ball cutters '
      + '(reuse filletEdges singleton math + #49 chains; relax planar assert '
      + 'for generator walls; junction caps optional). Face-offset remains a '
      + 'later multi-slice if Manifold gains solid offset or we build one.',
  };
}
