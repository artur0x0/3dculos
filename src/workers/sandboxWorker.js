// Browser / worker entry. Helpers and the message protocol live in
// src/lib/surfcad/runtime.js so Node can run the same script evaluator.
import { bindWorker } from '../lib/surfcad/runtime.js';

// Dedicated workers expose `self`. Node goldens assign the same object on
// globalThis before this module is imported.
const workerScope = typeof self !== 'undefined' ? self : globalThis.self;
bindWorker(workerScope);
