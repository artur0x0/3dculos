import assert from 'node:assert/strict';
import test from 'node:test';
import { initialFeaProgress, reduceFeaProgress } from './feaProgress.js';
import { createFeaWorkerHost } from './feaRunSession.js';
import { FeaMessage } from './protocol.js';

function fakeWorker() {
  let onmessage = null;
  let onerror = null;
  let onmessageerror = null;
  return {
    sent: [],
    terminated: false,
    get onmessage() { return onmessage; },
    set onmessage(fn) { onmessage = fn; },
    get onerror() { return onerror; },
    set onerror(fn) { onerror = fn; },
    get onmessageerror() { return onmessageerror; },
    set onmessageerror(fn) { onmessageerror = fn; },
    postMessage(data) { this.sent.push(data); },
    terminate() { this.terminated = true; },
    emit(data) { onmessage?.({ data }); },
    die(message) { onerror?.({ message, preventDefault() {} }); },
    garble(message) { onmessageerror?.({ message, preventDefault() {} }); },
  };
}

function hostWith(worker, nowRef, timeout = 20_000) {
  let tick = () => {};
  const host = createFeaWorkerHost(worker, {
    now: () => nowRef.value,
    heartbeatTimeoutMs: timeout,
    schedule(fn) {
      tick = fn;
      return 1;
    },
    clear() { tick = () => {}; },
  });
  return { host, tick: () => tick() };
}

test('killing the worker mid-solve reports Stopped during Solving', async () => {
  const worker = fakeWorker();
  const now = { value: 1000 };
  const { host } = hostWith(worker, now);
  worker.emit({ type: FeaMessage.loaded });
  await host.ready;

  let state = reduceFeaProgress(initialFeaProgress(1000), { type: 'start', now: 1000 });
  const pending = host.request(FeaMessage.solve, {}, [], {
    onProgress(event) {
      state = reduceFeaProgress(state, event);
    },
  });
  const solve = worker.sent.find((message) => message.type === FeaMessage.solve);
  now.value = 42000;
  worker.emit({
    type: FeaMessage.progress,
    id: solve.id,
    stage: 'solving',
    dofs: 98000,
    t: 42000,
  });
  worker.die('out of memory');

  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'FeaWorkerError');
    assert.equal(error.outcome, 'worker-died');
    assert.equal(error.message, 'out of memory');
    return true;
  });
  assert.equal(state.text, 'Stopped during Solving after 41 s (98k DOF): out of memory');
  assert.equal(worker.terminated, false);
});

test('a messageerror mid-solve is the same Stopped during report', async () => {
  const worker = fakeWorker();
  const now = { value: 0 };
  const { host } = hostWith(worker, now);
  worker.emit({ type: FeaMessage.loaded });
  await host.ready;

  let state = reduceFeaProgress(initialFeaProgress(0), { type: 'start', now: 0 });
  const pending = host.request(FeaMessage.solve, {}, [], {
    onProgress(event) {
      state = reduceFeaProgress(state, event);
    },
  });
  const solve = worker.sent.find((message) => message.type === FeaMessage.solve);
  worker.emit({ type: FeaMessage.progress, id: solve.id, stage: 'meshing', t: 0 });
  now.value = 3000;
  worker.garble('could not deserialize');

  await assert.rejects(pending, /could not deserialize/);
  assert.equal(state.text, 'Stopped during Meshing after 3.0 s: could not deserialize');
});

test('no heartbeat for over 20s during a stage stops the run', async () => {
  const worker = fakeWorker();
  const now = { value: 0 };
  const { host, tick } = hostWith(worker, now);
  worker.emit({ type: FeaMessage.loaded });
  await host.ready;

  let state = reduceFeaProgress(initialFeaProgress(0), { type: 'start', now: 0 });
  const pending = host.request(FeaMessage.solve, {}, [], {
    onProgress(event) {
      state = reduceFeaProgress(state, event);
    },
  });
  const solve = worker.sent.find((message) => message.type === FeaMessage.solve);
  worker.emit({ type: FeaMessage.progress, id: solve.id, stage: 'assembling', t: 0 });
  now.value = 19_000;
  tick();
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  now.value = 20_001;
  tick();
  await assert.rejects(pending, /worker stopped responding/);
  assert.equal(state.text, 'Stopped during Assembling after 20 s: worker stopped responding');
});

test('a blocking wasm call does not trip the watchdog, and onerror still does', async () => {
  const worker = fakeWorker();
  const now = { value: 0 };
  const { host, tick } = hostWith(worker, now);
  worker.emit({ type: FeaMessage.loaded });
  await host.ready;

  let state = reduceFeaProgress(initialFeaProgress(0), { type: 'start', now: 0 });
  const pending = host.request(FeaMessage.solve, {}, [], {
    onProgress(event) {
      state = reduceFeaProgress(state, event);
    },
  });
  const solve = worker.sent.find((message) => message.type === FeaMessage.solve);
  worker.emit({
    type: FeaMessage.progress,
    id: solve.id,
    stage: 'meshing',
    blocking: true,
    t: 0,
  });
  now.value = 60_000;
  tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  worker.die('Uncaught RuntimeError: out of memory');
  await assert.rejects(pending, /out of memory/);
  assert.equal(state.text, 'Stopped during Meshing after 60 s: out of memory');
});

test('cancel still rejects the solve and tells the worker', async () => {
  const worker = fakeWorker();
  const now = { value: 0 };
  const { host } = hostWith(worker, now);
  worker.emit({ type: FeaMessage.loaded });
  await host.ready;

  const controller = new AbortController();
  const pending = host.request(FeaMessage.solve, {}, [], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(worker.sent.some((message) => message.type === FeaMessage.cancel), true);
});

test('a heartbeat refreshes the 20s window', async () => {
  const worker = fakeWorker();
  const now = { value: 0 };
  const { host, tick } = hostWith(worker, now);
  worker.emit({ type: FeaMessage.loaded });
  await host.ready;

  let state = reduceFeaProgress(initialFeaProgress(0), { type: 'start', now: 0 });
  const pending = host.request(FeaMessage.solve, {}, [], {
    onProgress(event) {
      state = reduceFeaProgress(state, event);
    },
  });
  const solve = worker.sent.find((message) => message.type === FeaMessage.solve);
  worker.emit({ type: FeaMessage.progress, id: solve.id, stage: 'solving', t: 0 });
  now.value = 15_000;
  worker.emit({ type: FeaMessage.heartbeat, id: solve.id, stage: 'solving', t: 15_000 });
  now.value = 30_000;
  tick();
  worker.emit({ type: FeaMessage.progress, id: solve.id, stage: 'post-processing', t: 30_000 });
  now.value = 31_000;
  worker.emit({ id: solve.id, ok: true, result: { stats: { dofs: 4 } } });
  const result = await pending;
  assert.equal(result.stats.dofs, 4);
  assert.equal(state.stage, 'post-processing');
  assert.equal(state.status, 'running');
});
