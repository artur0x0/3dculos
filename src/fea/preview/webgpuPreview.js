/**
 * WebGPU driver for the voxel preview.
 *
 * Ke, the Jacobi weight, and the fixed mask come from the JS hierarchy.
 * Matvec, Jacobi, restriction, and prolongation run as compute. The
 * coarsest grid is solved on the CPU with the dense factor. CG stays on
 * the CPU and dispatches those kernels. No adapter, or limits too small,
 * is a failed probe: the panel hides the sliders and Run is unchanged.
 */

/* global GPUBufferUsage, GPUShaderStage, GPUMapMode */
import { PRE_SMOOTH, POST_SMOOTH, solveCoarse } from './multigrid.js';
import { PREVIEW_WGSL } from './previewShader.js';
import { finishVoxelPreview, prepareVoxelPreview } from './solvePreview.js';

let probed = null;

function limitsOf(adapter) {
  const limits = adapter?.limits || {};
  return {
    maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage || 8,
    maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize || (128 * 1024 * 1024),
    maxBufferSize: limits.maxBufferSize || (256 * 1024 * 1024),
    maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension || 65535,
  };
}

async function probeOnce() {
  const gpu = typeof navigator !== 'undefined' ? navigator.gpu : null;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return { ok: false, reason: 'no-webgpu' };
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { ok: false, reason: 'no-adapter' };
    const limits = limitsOf(adapter);
    const requiredLimits = {};
    if (limits.maxStorageBuffersPerShaderStage >= 10) {
      requiredLimits.maxStorageBuffersPerShaderStage = 10;
    }
    const device = await adapter.requestDevice({ requiredLimits });
    const solver = new GpuPreview(device, limits);
    const compiled = await solver.compile();
    if (!compiled.ok) {
      solver.destroy();
      return { ok: false, reason: compiled.reason || 'shader' };
    }
    return { ok: true, device, solver, limits, reason: '' };
  } catch (err) {
    return { ok: false, reason: err?.message || 'webgpu' };
  }
}

/** One probe per page. A failure stays a failure. */
export function probePreviewGpu() {
  if (!probed) probed = probeOnce();
  return probed;
}

export function resetPreviewGpuProbe() {
  probed = null;
}

function packParams(level, coarse, omega, span) {
  const raw = new ArrayBuffer(64);
  const ints = new Int32Array(raw);
  const floats = new Float32Array(raw);
  ints[0] = level.nx;
  ints[1] = level.ny;
  ints[2] = level.nz;
  ints[3] = level.nxp;
  ints[4] = level.nyp;
  ints[5] = level.nzp;
  ints[6] = level.nodeCount;
  ints[7] = level.nx * level.ny * level.nz;
  ints[8] = coarse ? coarse.nx : 1;
  ints[9] = coarse ? coarse.ny : 1;
  ints[10] = coarse ? coarse.nz : 1;
  ints[11] = coarse ? coarse.nxp : 2;
  ints[12] = coarse ? coarse.nyp : 2;
  ints[13] = coarse ? coarse.nodeCount : 1;
  floats[14] = omega;
  floats[15] = span;
  return raw;
}

function asF32(src) {
  if (src instanceof Float32Array) return src;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 1) out[i] = src[i];
  return out;
}

function asU32(src) {
  const out = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i += 1) out[i] = src[i] ? 1 : 0;
  return out;
}

class GpuPreview {
  constructor(device, limits) {
    this.device = device;
    this.limits = limits;
    this.bytes = 0;
    this.levels = new Map();
    this.paramPool = [];
    this.paramUsed = 0;
    this.enc = null;
    this.pipelines = null;
    this.mainLayout = null;
    this.dotLayout = null;
    this.live = () => true;
  }

  storage(data) {
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const size = Math.max(4, data.byteLength);
    const buf = this.device.createBuffer({ size, usage, mappedAtCreation: true });
    if (data instanceof Uint32Array) new Uint32Array(buf.getMappedRange()).set(data);
    else new Float32Array(buf.getMappedRange()).set(data);
    buf.unmap();
    this.bytes += size;
    return buf;
  }

  empty(size) {
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const buf = this.device.createBuffer({ size: Math.max(4, size), usage });
    this.bytes += Math.max(4, size);
    return buf;
  }

  async compile() {
    const module = this.device.createShaderModule({ code: PREVIEW_WGSL });
    const info = await module.getCompilationInfo();
    const error = (info.messages || []).find((message) => message.type === 'error');
    if (error) return { ok: false, reason: error.message };
    const compute = GPUShaderStage.COMPUTE;
    const read = { type: 'read-only-storage' };
    const write = { type: 'storage' };
    this.mainLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: compute, buffer: { type: 'uniform' } },
        { binding: 1, visibility: compute, buffer: read },
        { binding: 2, visibility: compute, buffer: read },
        { binding: 3, visibility: compute, buffer: read },
        { binding: 4, visibility: compute, buffer: read },
        { binding: 5, visibility: compute, buffer: read },
        { binding: 6, visibility: compute, buffer: write },
        { binding: 7, visibility: compute, buffer: read },
        { binding: 8, visibility: compute, buffer: read },
        { binding: 9, visibility: compute, buffer: write },
      ],
    });
    this.dotLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: compute, buffer: write }],
    });
    const plain = this.device.createPipelineLayout({ bindGroupLayouts: [this.mainLayout] });
    const dotted = this.device.createPipelineLayout({ bindGroupLayouts: [this.mainLayout, this.dotLayout] });
    const make = (name, layout) => this.device.createComputePipeline({
      layout,
      compute: { module, entryPoint: name },
    });
    this.pipelines = {
      matvec: make('matvec', plain),
      jacobi: make('jacobi', plain),
      restrict: make('restrictToCoarse', plain),
      prolongAdd: make('prolongAdd', plain),
      axpy: make('axpy', plain),
      dotPartial: make('dotPartial', dotted),
    };
    this.dummyRead = this.empty(4);
    this.dummyWrite = this.empty(4);
    return { ok: true };
  }

  upload(op) {
    const names = ['u', 'u2', 'r', 'r2', 'p', 'z', 'z2', 'az', 'defect', 'rhs'];
    const vecBytes = op.nodeCount * 12;
    const vec = {};
    for (let i = 0; i < names.length; i += 1) vec[names[i]] = this.empty(vecBytes);
    const partialGroups = Math.max(1, Math.ceil(op.nodeCount / 64));
    const gpu = {
      op,
      stamp: op.previewStamp || 0,
      nx: op.nx,
      ny: op.ny,
      nz: op.nz,
      nxp: op.nxp,
      nyp: op.nyp,
      nzp: op.nzp,
      nodeCount: op.nodeCount,
      ke: this.storage(asF32(op.ke)),
      occupancy: this.storage(asU32(op.occupancy)),
      fixed: this.storage(asU32(op.fixed)),
      diag: this.storage(asF32(op.diag)),
      zeros: this.empty(vecBytes),
      vec,
      partial: this.empty(partialGroups * 4),
      partialGroups,
    };
    this.levels.set(op, gpu);
    return gpu;
  }

  level(op) {
    const stamp = op.previewStamp || 0;
    const existing = this.levels.get(op);
    if (existing && existing.stamp === stamp) return existing;
    if (existing) this.destroyLevel(op, existing);
    return this.upload(op);
  }

  destroyLevel(op, gpu) {
    const buffers = [gpu.ke, gpu.occupancy, gpu.fixed, gpu.diag, gpu.zeros, gpu.partial];
    const vecs = Object.values(gpu.vec);
    for (let i = 0; i < buffers.length; i += 1) buffers[i]?.destroy?.();
    for (let i = 0; i < vecs.length; i += 1) vecs[i]?.destroy?.();
    this.levels.delete(op);
  }

  retain(op) {
    const keep = new Set();
    let level = op;
    while (level) {
      keep.add(level);
      level = level.coarser;
    }
    for (const [key, gpu] of this.levels) {
      if (!keep.has(key)) this.destroyLevel(key, gpu);
    }
  }

  params(level, coarse, omega, span) {
    let buf = this.paramPool[this.paramUsed];
    if (!buf) {
      buf = this.device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.paramPool[this.paramUsed] = buf;
      this.bytes += 64;
    }
    this.paramUsed += 1;
    this.device.queue.writeBuffer(buf, 0, packParams(level, coarse, omega, span));
    return buf;
  }

  bind(pipeline, level, coarse, { a, b, c, omega = 0, span = 0, dotted = false }) {
    const group = this.device.createBindGroup({
      layout: this.mainLayout,
      entries: [
        { binding: 0, resource: { buffer: this.params(level, coarse, omega, span) } },
        { binding: 1, resource: { buffer: level.ke } },
        { binding: 2, resource: { buffer: level.occupancy } },
        { binding: 3, resource: { buffer: level.fixed } },
        { binding: 4, resource: { buffer: level.diag } },
        { binding: 5, resource: { buffer: level.vec[a] || level.zeros } },
        { binding: 6, resource: { buffer: level.vec[b] || level.zeros } },
        { binding: 7, resource: { buffer: level.vec[c] || level.zeros } },
        { binding: 8, resource: { buffer: coarse ? coarse.fixed : this.dummyRead } },
        { binding: 9, resource: { buffer: coarse ? coarse.vec.rhs : this.dummyWrite } },
      ],
    });
    if (!this.enc) this.enc = this.device.createCommandEncoder();
    const pass = this.enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    if (dotted) {
      const dots = this.device.createBindGroup({
        layout: this.dotLayout,
        entries: [{ binding: 0, resource: { buffer: level.partial } }],
      });
      pass.setBindGroup(1, dots);
    }
    const groups = Math.ceil(level.nodeCount / 64);
    pass.dispatchWorkgroups(Math.max(1, groups));
    pass.end();
  }

  submit() {
    if (!this.enc) return;
    this.device.queue.submit([this.enc.finish()]);
    this.enc = null;
    this.paramUsed = 0;
  }

  writeVec(level, name, values) {
    const f = asF32(values);
    this.device.queue.writeBuffer(level.vec[name], 0, f);
  }

  async readBuffer(buf, size) {
    const stage = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    if (!this.enc) this.enc = this.device.createCommandEncoder();
    this.enc.copyBufferToBuffer(buf, 0, stage, 0, size);
    this.submit();
    await stage.mapAsync(GPUMapMode.READ);
    const copy = new Float32Array(stage.getMappedRange().slice(0));
    stage.unmap();
    stage.destroy();
    return copy;
  }

  encode(kind, level, coarse, slots) {
    this.bind(this.pipelines[kind], level, coarse, slots);
  }

  async dot(level, a, c) {
    // dotPartial does not write fieldB. Binding 6 is still read-write, so it
    // must not be the same buffer as fieldA or fieldC.
    const spare = ['az', 'defect', 'z2', 'u2', 'r2', 'p'].find((name) => name !== a && name !== c) || 'z2';
    this.encode('dotPartial', level, null, { a, b: spare, c, dotted: true });
    const raw = await this.readBuffer(level.partial, level.partialGroups * 4);
    let sum = 0;
    for (let i = 0; i < raw.length; i += 1) sum += raw[i];
    return sum;
  }

  swap(level, left, right) {
    const tmp = level.vec[left];
    level.vec[left] = level.vec[right];
    level.vec[right] = tmp;
  }

  async smooth(level, zName, rhsName, iters) {
    let cur = zName;
    let alt = zName === 'z' ? 'z2' : 'z';
    for (let s = 0; s < iters; s += 1) {
      this.encode('jacobi', level, null, {
        a: cur,
        b: alt,
        c: rhsName,
        omega: level.op.omega || 0.3,
      });
      const swap = cur;
      cur = alt;
      alt = swap;
    }
    if (cur !== zName) {
      this.encode('axpy', level, null, { a: cur, b: zName, c: cur, omega: 0, span: 0 });
    }
  }

  async vcycle(level, rhsName, zName) {
    if (!this.live()) return;
    if (!level.op.coarser) {
      const rhs = await this.readBuffer(level.vec[rhsName], level.nodeCount * 12);
      if (!this.live()) return;
      const z = solveCoarse(level.op, rhs);
      this.writeVec(level, zName, z);
      return;
    }
    this.encode('axpy', level, null, { a: 'zeros', b: zName, c: 'zeros', omega: 0, span: 0 });
    await this.smooth(level, zName, rhsName, PRE_SMOOTH);
    this.encode('matvec', level, null, { a: zName, b: 'az', c: 'zeros' });
    this.encode('axpy', level, null, { a: 'az', b: 'defect', c: rhsName, omega: -1, span: 0 });
    const coarse = this.level(level.op.coarser);
    this.bind(this.pipelines.restrict, level, coarse, { a: 'defect', b: 'z', c: 'zeros' });
    // restrict writes coarse.vec.rhs via binding 9. The bind() helper always
    // targets coarse.vec.rhs, which is the coarse right-hand side.
    this.submit();
    await this.vcycle(coarse, 'rhs', 'z');
    if (!this.live()) return;
    this.prolong(level, coarse, zName);
    await this.smooth(level, zName, rhsName, POST_SMOOTH);
  }

  prolong(level, coarse, zName) {
    const group = this.device.createBindGroup({
      layout: this.mainLayout,
      entries: [
        { binding: 0, resource: { buffer: this.params(level, coarse, 0, 0) } },
        { binding: 1, resource: { buffer: level.ke } },
        { binding: 2, resource: { buffer: level.occupancy } },
        { binding: 3, resource: { buffer: level.fixed } },
        { binding: 4, resource: { buffer: level.diag } },
        { binding: 5, resource: { buffer: level.vec[zName] } },
        { binding: 6, resource: { buffer: level.vec.z2 } },
        { binding: 7, resource: { buffer: level.zeros } },
        { binding: 8, resource: { buffer: coarse.fixed } },
        { binding: 9, resource: { buffer: coarse.vec.z } },
      ],
    });
    if (!this.enc) this.enc = this.device.createCommandEncoder();
    const pass = this.enc.beginComputePass();
    pass.setPipeline(this.pipelines.prolongAdd);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.max(1, Math.ceil(level.nodeCount / 64)));
    pass.end();
    this.swap(level, zName, 'z2');
  }

  async pcg(op, rhs, u, { tol = 1e-4, maxIter = 24, isCurrent } = {}) {
    this.live = isCurrent || (() => true);
    this.retain(op);
    const fine = this.level(op);
    if (fine.nodeCount * 12 > this.limits.maxStorageBufferBindingSize) {
      throw new Error('The preview grid does not fit this GPU.');
    }
    this.writeVec(fine, 'u', u);
    this.writeVec(fine, 'rhs', rhs);
    this.encode('matvec', fine, null, { a: 'u', b: 'az', c: 'zeros' });
    this.encode('axpy', fine, null, { a: 'az', b: 'r', c: 'rhs', omega: -1, span: 0 });
    const residual0 = Math.sqrt(Math.max(0, await this.dot(fine, 'r', 'r')));
    const rhsNorm = Math.sqrt(Math.max(0, await this.dot(fine, 'rhs', 'rhs')));
    const history = [1];
    if (!this.live()) return { stale: true };
    if (!(residual0 > 0) || residual0 < tol * Math.max(1, rhsNorm)) {
      return { iterations: 0, residual: 0, residual0, history, gpuBytes: this.bytes };
    }
    await this.vcycle(fine, 'r', 'z');
    this.encode('axpy', fine, null, { a: 'z', b: 'p', c: 'z', omega: 0, span: 0 });
    let rz = await this.dot(fine, 'r', 'z');
    let iterations = 0;
    let residual = residual0;
    for (let iter = 0; iter < maxIter; iter += 1) {
      if (!this.live()) return { stale: true };
      iterations = iter + 1;
      this.encode('matvec', fine, null, { a: 'p', b: 'az', c: 'zeros' });
      const pAp = await this.dot(fine, 'p', 'az');
      if (!(pAp > 0)) break;
      const alpha = rz / pAp;
      this.encode('axpy', fine, null, { a: 'p', b: 'u2', c: 'u', omega: alpha, span: 0 });
      this.swap(fine, 'u', 'u2');
      this.encode('axpy', fine, null, { a: 'az', b: 'r2', c: 'r', omega: -alpha, span: 0 });
      this.swap(fine, 'r', 'r2');
      residual = Math.sqrt(Math.max(0, await this.dot(fine, 'r', 'r')));
      history.push(residual / residual0);
      if (residual / residual0 <= tol) break;
      await this.vcycle(fine, 'r', 'z');
      if (!this.live()) return { stale: true };
      const next = await this.dot(fine, 'r', 'z');
      const beta = rz !== 0 ? next / rz : 0;
      this.encode('axpy', fine, null, { a: 'z', b: 'p', c: 'z', omega: 0, span: beta });
      rz = next;
    }
    if (!this.live()) return { stale: true };
    const out = await this.readBuffer(fine.vec.u, fine.nodeCount * 12);
    for (let i = 0; i < u.length; i += 1) u[i] = out[i] || 0;
    return {
      iterations,
      residual: residual0 > 0 ? residual / residual0 : 0,
      residual0,
      history,
      gpuBytes: this.bytes,
    };
  }

  destroy() {
    for (const [key, gpu] of this.levels) this.destroyLevel(key, gpu);
    this.dummyRead?.destroy?.();
    this.dummyWrite?.destroy?.();
    for (let i = 0; i < this.paramPool.length; i += 1) this.paramPool[i].destroy?.();
    this.device?.destroy?.();
  }
}

export async function runGpuPreview(gpu, args) {
  if (!gpu?.solver) throw new Error('Preview has no WebGPU device.');
  const started = Date.now();
  const ctx = prepareVoxelPreview(args);
  if (args.isCurrent && !args.isCurrent()) return { stale: true };
  const solved = await gpu.solver.pcg(ctx.operator, ctx.rhs, ctx.u, {
    tol: args.tol ?? 1e-4,
    maxIter: args.maxIter ?? 24,
    isCurrent: args.isCurrent,
  });
  if (!solved || solved.stale) return { stale: true };
  return finishVoxelPreview(ctx, solved, started);
}
