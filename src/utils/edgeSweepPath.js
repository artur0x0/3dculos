/**
 * Slice 22 — Edge → ordered sweep path / wire.
 *
 * Pure helpers shared by palette preview, goldens, and docs examples.
 * Script-facing makeSweepPath lives in sandboxWorker (mirrors assembleSweepPath).
 *
 * Value shape (plain object, no class inheritance):
 *   {
 *     kind: 'sweepPath',
 *     closed: boolean,
 *     points: number[][],   // ordered XYZ polyline (closed: first≠last; use closed flag)
 *     length: number,
 *     edgeCount: number,
 *   }
 *
 * Does NOT sweep a cutter / fillet — path value only for later slices.
 */

import { edgeKey, buildEdgeVertexAdj } from './selectEdge.js';

export const SWEEP_PATH_EMPTY =
  'Select edges first (Edge pick mode), then Path. Tangent-on chains work for circular rims.';

export const SWEEP_PATH_DISCONNECTED =
  'Selected edges are disconnected — pick a single contiguous chain or loop (use Tangent for circular rims).';

export const SWEEP_PATH_BRANCH =
  'Selected edges branch (junction) — Path needs a simple open chain or closed loop, not a Y/T junction.';

export const SWEEP_PATH_INVALID =
  'Could not order selected edges into a path — re-pick a contiguous chain or loop.';

function _dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function _mid(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function _sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function _add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function _mul(s, a) {
  return [s * a[0], s * a[1], s * a[2]];
}

function _len(v) {
  return Math.hypot(v[0], v[1], v[2]) || 1;
}

function _n(v) {
  const L = _len(v);
  return [v[0] / L, v[1] / L, v[2] / L];
}

/**
 * Normalize a selected / feature edge into a copy with key + endpoints.
 * @param {object} edge
 * @returns {object|null}
 */
export function normalizePathEdge(edge) {
  if (!edge) return null;
  const va = edge.va;
  const vb = edge.vb;
  if (!Array.isArray(va) || !Array.isArray(vb) || va.length < 3 || vb.length < 3) return null;
  const a = Number.isFinite(edge.a) ? edge.a : 0;
  const b = Number.isFinite(edge.b) ? edge.b : 1;
  const key = edgeKey(edge) || `${Math.min(a, b)}-${Math.max(a, b)}`;
  let length = Number(edge.length);
  if (!(length > 0)) length = _dist(va, vb);
  if (!(length > 1e-12)) return null;
  return {
    key,
    a,
    b,
    va: [Number(va[0]), Number(va[1]), Number(va[2])],
    vb: [Number(vb[0]), Number(vb[1]), Number(vb[2])],
    mid: Array.isArray(edge.mid)
      ? [Number(edge.mid[0]), Number(edge.mid[1]), Number(edge.mid[2])]
      : _mid(va, vb),
    length,
    tangent: edge.tangent ? edge.tangent.slice() : undefined,
  };
}

/** Orient so .a/.va sit at fromVert (mesh vertex index). */
function orientFromVert(edge, fromVert) {
  if (edge.a === fromVert) {
    return {
      key: edge.key,
      a: edge.a,
      b: edge.b,
      va: edge.va.slice(),
      vb: edge.vb.slice(),
      mid: edge.mid ? edge.mid.slice() : _mid(edge.va, edge.vb),
      length: edge.length,
      tangent: edge.tangent ? edge.tangent.slice() : undefined,
    };
  }
  return {
    key: edge.key,
    a: edge.b,
    b: edge.a,
    va: edge.vb.slice(),
    vb: edge.va.slice(),
    mid: edge.mid ? edge.mid.slice() : _mid(edge.va, edge.vb),
    length: edge.length,
    tangent: edge.tangent
      ? [-edge.tangent[0], -edge.tangent[1], -edge.tangent[2]]
      : undefined,
  };
}

/**
 * Order selected edges into a contiguous open chain or closed loop.
 *
 * Open: walk from a degree-1 endpoint.
 * Closed: all degrees 2; walk from the first selected edge.
 * Soft-fails (ok:false) on empty, disconnected, or branched selections.
 *
 * @param {object[]} selectedEdges
 * @returns {{
 *   ok: true,
 *   closed: boolean,
 *   orderedEdges: object[],
 *   points: number[][],
 *   length: number,
 * } | {
 *   ok: false,
 *   code: 'empty'|'disconnected'|'branch'|'invalid',
 *   message: string,
 * }}
 */
export function orderEdgePath(selectedEdges) {
  const raw = Array.isArray(selectedEdges) ? selectedEdges : [];
  const uniq = new Map();
  for (const e of raw) {
    if (!e) continue;
    if (!Number.isFinite(e.a) || !Number.isFinite(e.b)) continue;
    const n = normalizePathEdge(e);
    if (!n) continue;
    if (!uniq.has(n.key)) uniq.set(n.key, n);
  }
  const unique = [...uniq.values()];
  if (!unique.length) {
    return { ok: false, code: 'empty', message: SWEEP_PATH_EMPTY };
  }

  const adj = buildEdgeVertexAdj(unique);

  // Connected component on the edge graph.
  const visited = new Set();
  const q = [unique[0]];
  visited.add(unique[0].key);
  while (q.length) {
    const cur = q.shift();
    for (const v of [cur.a, cur.b]) {
      for (const nbr of adj.get(v) || []) {
        const nk = edgeKey(nbr);
        if (visited.has(nk)) continue;
        visited.add(nk);
        q.push(nbr);
      }
    }
  }
  if (visited.size !== unique.length) {
    return { ok: false, code: 'disconnected', message: SWEEP_PATH_DISCONNECTED };
  }

  const endpoints = [];
  for (const [v, list] of adj) {
    if (list.length > 2) {
      return { ok: false, code: 'branch', message: SWEEP_PATH_BRANCH };
    }
    if (list.length === 1) endpoints.push(v);
  }

  const closed = endpoints.length === 0;
  if (!closed && endpoints.length !== 2) {
    return { ok: false, code: 'invalid', message: SWEEP_PATH_INVALID };
  }

  // Open: prefer an endpoint on the first-selected edge for stable direction.
  // Closed: start at unique[0].a.
  let startVert;
  if (closed) {
    startVert = unique[0].a;
  } else {
    const seed = unique[0];
    if (endpoints.includes(seed.a)) startVert = seed.a;
    else if (endpoints.includes(seed.b)) startVert = seed.b;
    else startVert = endpoints[0];
  }

  const used = new Set();
  const ordered = [];
  let curV = startVert;

  for (let guard = 0; guard < unique.length + 2; guard++) {
    const nbrs = (adj.get(curV) || []).filter((e) => !used.has(edgeKey(e)));
    if (!nbrs.length) break;

    let pick = nbrs[0];
    if (ordered.length === 0) {
      const prefer = nbrs.find((e) => edgeKey(e) === unique[0].key);
      if (prefer) pick = prefer;
    }

    const edge = orientFromVert(pick, curV);
    used.add(edge.key);
    ordered.push(edge);
    curV = edge.b;
    if (used.size === unique.length) break;
  }

  if (ordered.length !== unique.length) {
    return { ok: false, code: 'invalid', message: SWEEP_PATH_INVALID };
  }

  const points = [ordered[0].va.slice()];
  for (const e of ordered) points.push(e.vb.slice());

  let length = 0;
  for (const e of ordered) length += e.length;

  return {
    ok: true,
    closed,
    orderedEdges: ordered,
    points,
    length,
  };
}

/**
 * Assemble reusable sweep-path value (client / golden mirror of makeSweepPath).
 * Soft-fail shape when selection cannot form a path (ok:false).
 *
 * @param {object[]} selectedEdges
 * @param {{ reverse?: boolean }} [opts]
 */
export function assembleSweepPath(selectedEdges, opts = {}) {
  const ordered = orderEdgePath(selectedEdges);
  if (!ordered.ok) return ordered;

  let pts = ordered.points.map((p) => p.slice());
  let edges = ordered.orderedEdges.map((e) => ({
    key: e.key,
    a: e.a,
    b: e.b,
    va: e.va.slice(),
    vb: e.vb.slice(),
    mid: e.mid ? e.mid.slice() : _mid(e.va, e.vb),
    length: e.length,
  }));

  // Closed: drop duplicated closing vertex (sweepPoints uses closed:true).
  if (ordered.closed && pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (_dist(a, b) < 1e-5) pts = pts.slice(0, -1);
  }

  if (opts.reverse) {
    pts = pts.slice().reverse();
    edges = edges
      .slice()
      .reverse()
      .map((e) => ({
        ...e,
        a: e.b,
        b: e.a,
        va: e.vb.slice(),
        vb: e.va.slice(),
      }));
  }

  return {
    ok: true,
    value: {
      kind: 'sweepPath',
      closed: ordered.closed,
      points: pts,
      length: ordered.length,
      edgeCount: edges.length,
    },
    orderedEdges: edges,
  };
}

/**
 * Loud variant for script/golden parity with sandboxWorker makeSweepPath.
 * @param {object[]} edges
 * @param {{ reverse?: boolean }} [opts]
 */
export function makeSweepPathLoud(edges, opts = {}) {
  const r = assembleSweepPath(edges, opts);
  if (!r.ok) {
    throw new Error(r.message || `makeSweepPath: ${r.code}`);
  }
  return r.value;
}

/**
 * Preview payload for Viewport — ordered polyline + direction cues.
 * Distinct from #20 edge-selection halo (orange): gradient polyline + arrow ticks.
 *
 * @param {object[]} selectedEdges
 * @param {{ reverse?: boolean }} [opts]
 * @returns {object|null}
 */
export function buildSweepPathPreview(selectedEdges, opts = {}) {
  const r = assembleSweepPath(selectedEdges, opts);
  if (!r.ok || !r.value?.points?.length) return null;

  const pts = r.value.points.map((p) => p.slice());
  const drawPts = r.value.closed && pts.length >= 2
    ? [...pts, pts[0].slice()]
    : pts;

  if (drawPts.length < 2) return null;

  const nSeg = drawPts.length - 1;
  const colors = drawPts.map((_, i) => {
    const t = nSeg > 0 ? i / nSeg : 0;
    // Green → magenta (order / direction).
    const rC = Math.round(34 + t * (168 - 34));
    const gC = Math.round(197 + t * (85 - 197));
    const bC = Math.round(94 + t * (247 - 94));
    return [rC / 255, gC / 255, bC / 255];
  });

  const arrows = [];
  for (let i = 0; i < nSeg; i++) {
    const a = drawPts[i];
    const b = drawPts[i + 1];
    const dir = _n(_sub(b, a));
    const segLen = _dist(a, b);
    if (segLen < 1e-6) continue;
    const tip = _add(a, _mul(0.72, _sub(b, a)));
    const up = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const side = _n([
      dir[1] * up[2] - dir[2] * up[1],
      dir[2] * up[0] - dir[0] * up[2],
      dir[0] * up[1] - dir[1] * up[0],
    ]);
    const wing = Math.min(1.1, segLen * 0.18);
    const back = _add(tip, _mul(-wing * 1.4, dir));
    arrows.push({
      tip,
      left: _add(back, _mul(wing, side)),
      right: _add(back, _mul(-wing, side)),
    });
  }

  const markers = [];
  const step = Math.max(1, Math.ceil(pts.length / 12));
  for (let i = 0; i < pts.length; i += step) {
    markers.push({ pos: pts[i].slice(), index: i });
  }
  if (pts.length > 1 && (pts.length - 1) % step !== 0) {
    markers.push({ pos: pts[pts.length - 1].slice(), index: pts.length - 1 });
  }

  return {
    closed: r.value.closed,
    points: drawPts,
    colors,
    arrows,
    markers,
    length: r.value.length,
    edgeCount: r.value.edgeCount,
  };
}

/** True when selection can form a path (for modal gating). */
export function canBuildSweepPath(selectedEdges) {
  return assembleSweepPath(selectedEdges).ok === true;
}
