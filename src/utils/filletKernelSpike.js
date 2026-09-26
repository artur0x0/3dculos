/**
 * Slice C / C2 / C3 — fillet kernel (hard-edge path).
 *
 * Easy stays the #45–#46 dihedral sweep (`filletAlongPath`). Hard Accept
 * routes to a **variable-profile inscribed-arc sweep** along the coherent
 * path (C3): at each densified knot, an arc of radius R in the local wall
 * square (side ~2R) framed by adjacent face normals / path tangent.
 *
 * C2 segment rolling-ball (`filletEdges` + `relaxPlanar`) is superseded for
 * hard/loft when the production flag is on — it left zero-area scrap on
 * twisted generators. Easy Prim/boxy is unchanged.
 *
 * Manifold CrossSection has 2D offset; bundled Manifold solid has no
 * offset()/minkowski. Face-offset pair-blend stays out of scope.
 */

/** @typedef {'sweep-dihedral' | 'variable-profile-sweep' | 'rolling-ball-segment' | 'face-offset' | 'sphere-hull' | 'adaptive-multipass'} FilletKernelId */

export const FILLET_KERNEL_EASY = 'sweep-dihedral';

/** Production hard path (Slice C3). */
export const FILLET_KERNEL_HARD_RECOMMENDED = 'variable-profile-sweep';

/**
 * Production-on for hard-class Accept (Slice C3).
 * Easy never reads this flag. When true, hard Accept emits makeSweepPath +
 * filletAlongPath({ variableProfile: true }) instead of filletEdges+relaxPlanar.
 */
export const FILLET_HARD_KERNEL_TRIAL = true;

export const FILLET_KERNEL_CANDIDATES = Object.freeze([
  {
    id: 'variable-profile-sweep',
    title: 'Variable-profile inscribed-arc sweep (path-normal frames)',
    feasible: 'yes',
    note:
      'C3: densify the coherent path; at each knot build an inscribed arc of '
      + 'radius R in the local wall square (side ~2R) from adjacent face normals '
      + '+ path tangent. Adapts to loft twist. Loud scrap fail > Area≈0 banner.',
  },
  {
    id: 'sphere-hull',
    title: 'Rolling-ball / sphere (disk) boolean along the edge',
    feasible: 'partial',
    note:
      'Naive sausage hull massively over-cuts. True rolling-ball is the '
      + 'parallelepiped−cylinder construction (C2); superseded by variable-profile for hard.',
  },
  {
    id: 'face-offset',
    title: 'Face-offset / pair-blend between adjacent faces',
    feasible: 'blocked',
    note:
      'Bundled Manifold has no solid offset()/minkowski. CrossSection.offset is 2D-only.',
  },
  {
    id: 'hybrid',
    title: 'Hybrid: easy = dihedral sweep; hard = variable-profile',
    feasible: 'yes',
    note:
      'Matches #50 classifyFilletEdges. Easy goldens stay on sweep. Hard routes '
      + 'to C3 variable-profile inscribed-arc sweep.',
  },
  {
    id: 'adaptive-multipass',
    title: 'Adaptive / multi-pass sweep',
    feasible: 'weak',
    note: 'More booleans on mobile without fixing variable-dihedral frame error.',
  },
]);

/**
 * Pick the kernel id for a fillet class.
 * @param {'easy'|'hard'|'empty'|string|null|undefined} klass
 * @param {{ trial?: boolean }} [opts]
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
      ? 'hard-class Accept: variable-profile inscribed-arc sweep (C3)'
      : 'hard-class recommendation: variable-profile sweep (flag off)',
  };
}

/**
 * True when Fillet Accept should emit the hard variable-profile sweep.
 * @param {'easy'|'hard'|'empty'|string|null|undefined} klass
 * @param {{ trial?: boolean }} [opts]
 */
export function shouldUseHardVariableSweep(klass, opts = {}) {
  const pick = pickFilletKernelForClass(klass, opts);
  return klass === 'hard'
    && pick.kernel === FILLET_KERNEL_HARD_RECOMMENDED
    && pick.trial === true;
}

/**
 * @deprecated Use shouldUseHardVariableSweep (C3). Kept as alias so older
 * call sites / goldens that still name "rolling-ball" compile during migration.
 */
export function shouldUseHardRollingBall(klass, opts = {}) {
  return shouldUseHardVariableSweep(klass, opts);
}

/**
 * Effort note for Product / PR body.
 */
export function hardFilletKernelEffort() {
  return {
    effort: 'done',
    summary:
      'C3 wires hard-class Accept to variable-profile inscribed-arc sweep '
      + '(densified path-normal frames from the shared tangency field; '
      + 'supersedes C2 filletEdges+relaxPlanar for hard/loft). Easy stays '
      + 'dihedral sweep. Face-offset remains a later multi-slice.',
  };
}
