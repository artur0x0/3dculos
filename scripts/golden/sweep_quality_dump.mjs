/**
 * Run one script against a sandboxWorker and print the mesh as one JSON line.
 * argv: <absolute path to sandboxWorker.js> <script file>
 */
import { register } from 'node:module';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const workerPath = process.argv[2];
const scriptPath = process.argv[3];
if (!workerPath || !scriptPath) {
  console.error('usage: sweep_quality_dump.mjs <sandboxWorker.js> <script>');
  process.exit(2);
}

register(new URL('./manifold-resolve-hook.mjs', import.meta.url));

const pending = new Map();
let msgId = 0;
const workerSelf = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'loaded') return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.type === 'error') waiter.reject(new Error(msg.payload?.message || 'worker error'));
    else waiter.resolve(msg);
  },
};
globalThis.self = workerSelf;

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    Promise.resolve().then(() => {
      workerSelf.onmessage({ data: { type, payload, id } });
    });
  });
}

const script = fs.readFileSync(scriptPath, 'utf8');
await import(pathToFileURL(workerPath).href);
await send('init');
const res = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
const mesh = res.payload?.mesh;
if (!mesh?.vertProperties || !mesh?.triVerts) {
  console.error('no mesh', res.payload?.status, res.payload?.message);
  process.exit(1);
}
const out = {
  volume: res.payload.volume,
  tris: mesh.triVerts.length / 3,
  numProp: mesh.numProp || 3,
  vertProperties: Array.from(mesh.vertProperties),
  triVerts: Array.from(mesh.triVerts),
  faceID: mesh.faceID ? Array.from(mesh.faceID) : null,
};
process.stderr.write(JSON.stringify(out));
