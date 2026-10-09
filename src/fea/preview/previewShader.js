/**
 * WGSL twins of the matrix-free kernels in multigrid.js.
 *
 * Ke, the Jacobi weight, and the fixed-node mask are uploaded from JS.
 * One thread owns one node, so the matvec does not need floating-point
 * atomics. Coarse nodes are every other fine node. The coarsest grid is
 * solved on the CPU; these kernels stop above it.
 */

export const PREVIEW_WGSL = /* wgsl */ `
struct Params {
  nx: i32,
  ny: i32,
  nz: i32,
  nxp: i32,
  nyp: i32,
  nzp: i32,
  nodeCount: i32,
  cellCount: i32,
  cnx: i32,
  cny: i32,
  cnz: i32,
  cnpx: i32,
  cnpy: i32,
  cnodeCount: i32,
  omega: f32,
  span: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> ke: array<f32>;
@group(0) @binding(2) var<storage, read> occupancy: array<u32>;
@group(0) @binding(3) var<storage, read> fixed: array<u32>;
@group(0) @binding(4) var<storage, read> diag: array<f32>;
@group(0) @binding(5) var<storage, read> fieldA: array<f32>;
@group(0) @binding(6) var<storage, read_write> fieldB: array<f32>;
@group(0) @binding(7) var<storage, read> fieldC: array<f32>;
@group(0) @binding(8) var<storage, read> coarseFixed: array<u32>;
@group(0) @binding(9) var<storage, read_write> coarseField: array<f32>;

fn nodeIndex(i: i32, j: i32, k: i32, nxp: i32, nyp: i32) -> i32 {
  return i + nxp * (j + nyp * k);
}

fn solidAt(i: i32, j: i32, k: i32) -> bool {
  if (i < 0 || j < 0 || k < 0 || i >= params.nx || j >= params.ny || k >= params.nz) {
    return false;
  }
  return occupancy[i + params.nx * (j + params.ny * k)] != 0u;
}

fn readVec(buf: ptr<storage, array<f32>, read>, node: i32, locked: u32) -> vec3f {
  if (locked != 0u) {
    return vec3f(0.0);
  }
  let at = node * 3;
  return vec3f((*buf)[at], (*buf)[at + 1], (*buf)[at + 2]);
}

fn nodeForce(node: i32, i: i32, j: i32, k: i32) -> vec3f {
  var force = vec3f(0.0);
  for (var dk = 0; dk <= 1; dk++) {
    for (var dj = 0; dj <= 1; dj++) {
      for (var di = 0; di <= 1; di++) {
        let ci = i - di;
        let cj = j - dj;
        let ck = k - dk;
        if (!solidAt(ci, cj, ck)) {
          continue;
        }
        let local = di + 2 * dj + 4 * dk;
        var ue: array<vec3f, 8>;
        let base = nodeIndex(ci, cj, ck, params.nxp, params.nyp);
        let sj = params.nxp;
        let sk = params.nxp * params.nyp;
        let nodes = array<i32, 8>(
          base,
          base + 1,
          base + sj,
          base + 1 + sj,
          base + sk,
          base + 1 + sk,
          base + sj + sk,
          base + 1 + sj + sk
        );
        for (var a = 0; a < 8; a++) {
          let id = nodes[a];
          ue[a] = readVec(&fieldA, id, fixed[id]);
        }
        for (var comp = 0; comp < 3; comp++) {
          let row = local * 3 + comp;
          var sum = 0.0;
          for (var a = 0; a < 8; a++) {
            let col = a * 3;
            sum += ke[row * 24 + col] * ue[a].x;
            sum += ke[row * 24 + col + 1] * ue[a].y;
            sum += ke[row * 24 + col + 2] * ue[a].z;
          }
          force[comp] += sum;
        }
      }
    }
  }
  return force;
}

@compute @workgroup_size(64)
fn matvec(@builtin(global_invocation_id) gid: vec3u) {
  let node = i32(gid.x);
  if (node >= params.nodeCount) {
    return;
  }
  let at = node * 3;
  if (fixed[node] != 0u) {
    fieldB[at] = 0.0;
    fieldB[at + 1] = 0.0;
    fieldB[at + 2] = 0.0;
    return;
  }
  let i = node % params.nxp;
  let t = node / params.nxp;
  let j = t % params.nyp;
  let k = t / params.nyp;
  let force = nodeForce(node, i, j, k);
  fieldB[at] = force.x;
  fieldB[at + 1] = force.y;
  fieldB[at + 2] = force.z;
}

@compute @workgroup_size(64)
fn jacobi(@builtin(global_invocation_id) gid: vec3u) {
  let node = i32(gid.x);
  if (node >= params.nodeCount) {
    return;
  }
  let at = node * 3;
  if (fixed[node] != 0u) {
    fieldB[at] = 0.0;
    fieldB[at + 1] = 0.0;
    fieldB[at + 2] = 0.0;
    return;
  }
  let i = node % params.nxp;
  let t = node / params.nxp;
  let j = t % params.nyp;
  let k = t / params.nyp;
  let force = nodeForce(node, i, j, k);
  let omega = params.omega;
  fieldB[at] = fieldA[at] + omega * (fieldC[at] - force.x) / diag[at];
  fieldB[at + 1] = fieldA[at + 1] + omega * (fieldC[at + 1] - force.y) / diag[at + 1];
  fieldB[at + 2] = fieldA[at + 2] + omega * (fieldC[at + 2] - force.z) / diag[at + 2];
}

fn weight1(delta: i32) -> f32 {
  if (delta == 0) {
    return 1.0;
  }
  return 0.5;
}

@compute @workgroup_size(64)
fn restrictToCoarse(@builtin(global_invocation_id) gid: vec3u) {
  let coarse = i32(gid.x);
  if (coarse >= params.cnodeCount) {
    return;
  }
  let at = coarse * 3;
  if (coarseFixed[coarse] != 0u) {
    coarseField[at] = 0.0;
    coarseField[at + 1] = 0.0;
    coarseField[at + 2] = 0.0;
    return;
  }
  let I = coarse % params.cnpx;
  let t = coarse / params.cnpx;
  let J = t % params.cnpy;
  let K = t / params.cnpy;
  var sum = vec3f(0.0);
  for (var dk = -1; dk <= 1; dk++) {
    for (var dj = -1; dj <= 1; dj++) {
      for (var di = -1; di <= 1; di++) {
        let i = I * 2 + di;
        let j = J * 2 + dj;
        let k = K * 2 + dk;
        if (i < 0 || j < 0 || k < 0 || i >= params.nxp || j >= params.nyp || k >= params.nzp) {
          continue;
        }
        let node = nodeIndex(i, j, k, params.nxp, params.nyp);
        if (fixed[node] != 0u) {
          continue;
        }
        let w = weight1(di) * weight1(dj) * weight1(dk);
        let src = node * 3;
        sum += w * vec3f(fieldA[src], fieldA[src + 1], fieldA[src + 2]);
      }
    }
  }
  coarseField[at] = sum.x;
  coarseField[at + 1] = sum.y;
  coarseField[at + 2] = sum.z;
}

@compute @workgroup_size(64)
fn prolongAdd(@builtin(global_invocation_id) gid: vec3u) {
  let node = i32(gid.x);
  if (node >= params.nodeCount) {
    return;
  }
  let at = node * 3;
  if (fixed[node] != 0u) {
    fieldB[at] = 0.0;
    fieldB[at + 1] = 0.0;
    fieldB[at + 2] = 0.0;
    return;
  }
  let i = node % params.nxp;
  let t = node / params.nxp;
  let j = t % params.nyp;
  let k = t / params.nyp;
  let I0 = i / 2;
  let J0 = j / 2;
  let K0 = k / 2;
  let wx = select(1.0, 0.5, (i & 1) == 1);
  let wy = select(1.0, 0.5, (j & 1) == 1);
  let wz = select(1.0, 0.5, (k & 1) == 1);
  let I1 = min(I0 + (i & 1), params.cnx);
  let J1 = min(J0 + (j & 1), params.cny);
  let K1 = min(K0 + (k & 1), params.cnz);
  let wi = select(0.0, 0.5, (i & 1) == 1);
  let wj = select(0.0, 0.5, (j & 1) == 1);
  let wk = select(0.0, 0.5, (k & 1) == 1);
  var acc = vec3f(0.0);
  let corners = array<vec4i, 8>(
    vec4i(I0, J0, K0, 0),
    vec4i(I1, J0, K0, 1),
    vec4i(I0, J1, K0, 2),
    vec4i(I1, J1, K0, 3),
    vec4i(I0, J0, K1, 4),
    vec4i(I1, J0, K1, 5),
    vec4i(I0, J1, K1, 6),
    vec4i(I1, J1, K1, 7)
  );
  let weights = array<f32, 8>(
    wx * wy * wz,
    wi * wy * wz,
    wx * wj * wz,
    wi * wj * wz,
    wx * wy * wk,
    wi * wy * wk,
    wx * wj * wk,
    wi * wj * wk
  );
  for (var c = 0; c < 8; c++) {
    let w = weights[c];
    if (w == 0.0) {
      continue;
    }
    let corner = corners[c];
    let cn = nodeIndex(corner.x, corner.y, corner.z, params.cnpx, params.cnpy);
    let src = cn * 3;
    acc += w * vec3f(coarseField[src], coarseField[src + 1], coarseField[src + 2]);
  }
  fieldB[at] = fieldA[at] + acc.x;
  fieldB[at + 1] = fieldA[at + 1] + acc.y;
  fieldB[at + 2] = fieldA[at + 2] + acc.z;
}

@compute @workgroup_size(64)
fn axpy(@builtin(global_invocation_id) gid: vec3u) {
  let node = i32(gid.x);
  if (node >= params.nodeCount) {
    return;
  }
  let at = node * 3;
  if (fixed[node] != 0u) {
    fieldB[at] = 0.0;
    fieldB[at + 1] = 0.0;
    fieldB[at + 2] = 0.0;
    return;
  }
  let alpha = params.omega;
  let beta = params.span;
  fieldB[at] = fieldC[at] + alpha * fieldA[at] + beta * fieldB[at];
  fieldB[at + 1] = fieldC[at + 1] + alpha * fieldA[at + 1] + beta * fieldB[at + 1];
  fieldB[at + 2] = fieldC[at + 2] + alpha * fieldA[at + 2] + beta * fieldB[at + 2];
}

struct DotOut {
  value: f32,
}

@group(1) @binding(0) var<storage, read_write> partial: array<f32>;
var<workgroup> scratch: array<f32, 64>;

@compute @workgroup_size(64)
fn dotPartial(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3u) {
  let node = i32(gid.x);
  var sum = 0.0;
  if (node < params.nodeCount && fixed[node] == 0u) {
    let at = node * 3;
    sum = fieldA[at] * fieldC[at] + fieldA[at + 1] * fieldC[at + 1] + fieldA[at + 2] * fieldC[at + 2];
  }
  scratch[lid] = sum;
  workgroupBarrier();
  var step = 32u;
  loop {
    if (step == 0u) {
      break;
    }
    if (lid < step) {
      scratch[lid] += scratch[lid + step];
    }
    workgroupBarrier();
    step = step / 2u;
  }
  if (lid == 0u) {
    partial[wid.x] = scratch[0];
  }
}
`;
