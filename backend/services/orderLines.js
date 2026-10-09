/**
 * One order, many lines. Old documents have no `lines` array; every reader
 * synthesizes a single line from `model-data` so they stay readable.
 *
 * lines of an order = order.lines if length > 0
 *                     else one synthesized line from model-data
 *                          (qty = Number(quantity) || 1)
 */

import { roundMoney } from '../../src/utils/quoteMath.js';

/**
 * 20 lines per order keeps N inline 3MFs inside the 10mb JSON body, with
 * room to reject a huge mesh. Expand in future.
 */
export const MAX_ORDER_LINES = 20;

export const USER_ORDERS_SELECT =
  '-model-data.script -model-data.model-file -lines.model-file';

const PROCESSES = new Set(['FDM', 'SLA', 'SLS', 'MJF']);

export function validateOrderLineCount(lines) {
  if (!Array.isArray(lines) || lines.length < 1) {
    return { ok: false, error: 'At least one line is required' };
  }
  if (lines.length > MAX_ORDER_LINES) {
    return { ok: false, error: 'An order can include at most 20 lines' };
  }
  return { ok: true };
}

export function readOrderLines(order) {
  const stored = order?.lines;
  if (Array.isArray(stored) && stored.length > 0) {
    return stored.map((line) => normalizeStoredLine(line));
  }
  return [synthesizeLine(order)];
}

export function pickModelFile(order, lineId) {
  const stored = order?.lines;
  const id = lineId == null ? '' : String(lineId);
  if (Array.isArray(stored) && stored.length > 0) {
    if (!id) return null;
    const hit = stored.find((line) => lineMatches(line, id));
    if (!hit) return null;
    return fileOf(hit);
  }
  if (id) return null;
  const modelData = order?.['model-data'] || order?.modelData;
  return fileOf(modelData) || null;
}

export function lineProcessOk(process) {
  return PROCESSES.has(process);
}

function lineMatches(line, id) {
  if (line?.lineId && String(line.lineId) === id) return true;
  const sub = line?._id?.toString?.() || (line?._id ? String(line._id) : '');
  return Boolean(sub) && sub === id;
}

function fileOf(source) {
  if (!source) return null;
  const file = source['model-file'] || source.modelFile;
  if (!file) return null;
  const data = file.data ?? file['data'];
  if (!data) return null;
  return file;
}

function normalizeStoredLine(line) {
  const plain = line?.toObject ? line.toObject() : { ...line };
  return {
    ...plain,
    synthesized: false,
  };
}

function synthesizeLine(order) {
  const modelData = order?.['model-data'] || order?.modelData || {};
  const qty = Number(modelData.quantity) || 1;
  const file = modelData['model-file'] || modelData.modelFile || null;
  const subtotal = Number(order?.quote?.subtotal);
  const extended = Number.isFinite(subtotal) ? roundMoney(subtotal) : null;
  const unit = extended != null && qty > 0 ? roundMoney(extended / qty) : null;
  return {
    lineId: null,
    partName: file?.filename || 'Part',
    assemblyName: null,
    partId: null,
    source: null,
    surfId: null,
    scriptHash: null,
    quoteId: null,
    process: modelData.process,
    material: modelData.material,
    infill: modelData.infill,
    quantity: qty,
    'volume-mm3': modelData['volume-mm3'] ?? modelData.volume ?? null,
    'bounding-box': modelData['bounding-box'] || modelData.boundingBox || null,
    'unit-subtotal': unit,
    'material-cost': null,
    'machine-cost': null,
    'model-file': file,
    synthesized: true,
  };
}
