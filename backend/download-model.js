#!/usr/bin/env node

import { MongoClient } from 'mongodb';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.development' });

async function downloadModelFile(orderNumber, outputPath) {
  const connectionString = process.env.MONGODB_URI;

  if (!connectionString) {
    console.error('MONGODB_URI not found in .env.development');
    process.exit(1);
  }

  if (!orderNumber) {
    console.error('Usage: node download-model.js <order-number> [output-path]');
    process.exit(1);
  }

  const client = new MongoClient(connectionString);

  try {
    await client.connect();
    console.log('Connected to MongoDB Atlas');

    const db = client.db('surfcad');
    const orders = db.collection('orders');

    // Find order by order-number
    const order = await orders.findOne({ 'order-number': orderNumber });

    if (!order) {
      console.error(`Order not found: ${orderNumber}`);
      process.exit(1);
    }

    // Check status is "paid"
    if (order.status !== 'paid') {
      console.error(`Order status is "${order.status}", not "paid". Aborting.`);
      process.exit(1);
    }

    // Retrieve base64 data from model-data -> model-file -> data
    const base64Data = order['model-data']?.['model-file']?.data;

    if (!base64Data) {
      console.error('No model file data found in order');
      process.exit(1);
    }

    // Convert base64 to buffer
    const buffer = Buffer.from(base64Data, 'base64');

    // Save to file
    const filename = outputPath || `${orderNumber}.3mf`;
    fs.writeFileSync(filename, buffer);

    console.log(`Successfully saved model to: ${filename}`);
    console.log(`File size: ${buffer.length} bytes`);

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await client.close();
    console.log('Connection closed');
  }
}

// Parse command line arguments
const [,, orderNumber, outputPath] = process.argv;

downloadModelFile(orderNumber, outputPath);