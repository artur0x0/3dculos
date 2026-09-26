/**
 * Slice C / C2 — fillet kernel (hard-edge path).
 *
 * Easy stays the #45–#46 dihedral sweep (`filletAlongPath`). Hard Accept
 * routes to segment-wise rolling-ball (`filletEdges` parallelepiped−cylinder
 * per #49 coherent segment with `relaxPlanar`) when the production flag is on.
 *
 * Measured on the box WASM worker (2026-09-25), cube 40×30×20 edge r=3 and a
 * circle→square hull stand-in for loft generators:
 *   - dihedral sweep (current): box volume error ~0.3%; ~50ms on easy edge
 *   - naive sphere-hull along bisector: over-removes ~12× analytic on box —
 *     not a rolling-ball fillet
 *   - filletEdges planar (parallelepiped − cylinder): box volume exact; fails
 *     loud on curved-adjacent loft generators without relaxPlanar
 *   - per-segment filletEdges try/catch on loft gens (strict planar): skips
 *     most segments; not a quality win
 *
 * Manifold CrossSection has 2D offset; bundled Manifold solid has no
 * offset()/minkowski (shell uses corner-sphere hull). Face-offset pair-blend
 * in 3D is therefore not a drop-in.
 */

/** @typedef {'sweep-dihedral' | 'rolling-ball-segment' | 'face-offset' | 'sphere-hull' | 'adaptive-multipass'} FilletKernelId */

export const FILLET_KERNEL_EASY = 'sweep-dihedral';

/** Production hard path (Slice C2). */
export const FILLET_KERNEL_HARD_RECOMMENDED = 'rolling-ball-segment';

/**
 * Production-on for hard-class Accept (Slice C2).
 * Easy never reads this flag. When true, hard Accept emits filletEdges with
 * relaxPlanar instead of a single RMF filletAlongPath sweep.
 */
export const FILLET_HARD_KERNEL_TRIAL = true;

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
 * Hard returns segment rolling-ball; `trial` mirrors the production flag
 * (true = Accept is wired to that path).
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
      ? 'hard-class Accept: segment rolling-ball (filletEdges + relaxPlanar)'
      : 'hard-class recommendation: segment rolling-ball (flag off)',
  };
}

/**
 * True when Fillet Accept should emit the hard rolling-ball path.
 * @param {'easy'|'hard'|'empty'|string|null|undefined} klass
 * @param {{ trial?: boolean }} [opts]
 */
export function shouldUseHardRollingBall(klass, opts = {}) {
  const pick = pickFilletKernelForClass(klass, opts);
  return klass === 'hard'
    && pick.kernel === FILLET_KERNEL_HARD_RECOMMENDED
    && pick.trial === true;
}

/**
 * Effort note for Product / PR body.
 * @returns {{ effort: '1-follow-up-PR'|'done'|'multi-slice', summary: string }}
 */
export function hardFilletKernelEffort() {
  return {
    effort: 'done',
    summary:
      'C2 wired hard-class Accept to segment-wise rolling-ball cutters '
      + '(filletEdges singleton math + #49 chains; relaxPlanar for generator '
      + 'walls; optional sphericalCorners junction caps). Face-offset remains a '
      + 'later multi-slice if Manifold gains solid offset or we build one.',
  };
}
