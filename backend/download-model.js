#!/usr/bin/env node

import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import dotenv from 'dotenv';
import { pickModelFile, readOrderLines } from './services/orderLines.js';

dotenv.config({ path: '.env.development' });

export function parseDownloadArgs(argv) {
  const args = argv.slice(2);
  let orderNumber = null;
  let lineId = null;
  let outputPath = null;
  const usage = 'Usage: node download-model.js <order-number> [--line <lineId>] [output-path]';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--line') {
      lineId = args[i + 1];
      i += 1;
      if (!lineId || lineId.startsWith('--')) return { error: usage };
      continue;
    }
    if (arg.startsWith('--')) return { error: usage };
    if (!orderNumber) orderNumber = arg;
    else if (!outputPath) outputPath = arg;
    else return { error: usage };
  }

  if (!orderNumber) return { error: usage };
  return { orderNumber, lineId, outputPath };
}

export function modelFileForDownload(order, lineId) {
  const stored = order?.lines;
  const hasLines = Array.isArray(stored) && stored.length > 0;
  if (hasLines && !lineId) {
    const lines = readOrderLines(order).map((line) => ({
      lineId: line.lineId,
      quantity: line.quantity,
      partName: line.partName,
    }));
    return { ok: false, needsLine: true, lines };
  }
  const file = pickModelFile(order, lineId || '');
  if (!file) return { ok: false, needsLine: false };
  const lines = readOrderLines(order);
  const match = lineId
    ? lines.find((line) => String(line.lineId) === String(lineId))
    : lines[0];
  return {
    ok: true,
    file,
    quantity: Number(match?.quantity) || 1,
  };
}

async function downloadModelFile(orderNumber, outputPath, lineId) {
  const connectionString = process.env.MONGODB_URI;

  if (!connectionString) {
    console.error('MONGODB_URI not found in .env.development');
    process.exit(1);
  }

  const client = new MongoClient(connectionString);

  try {
    await client.connect();
    console.log('Connected to MongoDB Atlas');

    const db = client.db('surfcad');
    const orders = db.collection('orders');

    const order = await orders.findOne({ 'order-number': orderNumber });

    if (!order) {
      console.error(`Order not found: ${orderNumber}`);
      process.exit(1);
    }

    if (order.status !== 'paid') {
      console.error(`Order status is "${order.status}", not "paid". Aborting.`);
      process.exit(1);
    }

    const picked = modelFileForDownload(order, lineId);
    if (!picked.ok && picked.needsLine) {
      console.error('This order has more than one part. Pass --line <lineId>.');
      for (const line of picked.lines) {
        console.error(`  ${line.lineId}  qty ${line.quantity}  ${line.partName}`);
      }
      process.exit(1);
    }
    if (!picked.ok) {
      console.error(lineId ? `No line ${lineId} on this order` : 'No model file data found in order');
      process.exit(1);
    }

    const base64Data = picked.file.data ?? picked.file['data'];
    const buffer = Buffer.from(base64Data, 'base64');
    const filename = outputPath || (lineId ? `${orderNumber}-${lineId}.3mf` : `${orderNumber}.3mf`);
    fs.writeFileSync(filename, buffer);

    console.log(`Successfully saved model to: ${filename}`);
    console.log(`File size: ${buffer.length} bytes`);
    console.log(`Copies to print: ${picked.quantity}`);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await client.close();
    console.log('Connection closed');
  }
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  const parsed = parseDownloadArgs(process.argv);
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(1);
  }
  downloadModelFile(parsed.orderNumber, parsed.outputPath, parsed.lineId);
}
