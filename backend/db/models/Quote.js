// db/models/Quote.js - server quote with the measured 3MF.
// quoteId, quotedAt, and quotedUnitPrice match the cart line. The TTL is
// QUOTE_TTL_MS from cartMerge.js (7 days), not a second constant.
import mongoose from 'mongoose';
import { QUOTE_TTL_MS } from '../../services/cartMerge.js';

const boundingBoxSchema = new mongoose.Schema({
  width: Number,
  height: Number,
  depth: Number,
}, { _id: false });

const modelFileSchema = new mongoose.Schema({
  filename: String,
  'content-type': String,
  'size-bytes': Number,
  'storage-type': {
    type: String,
    enum: ['inline', 'gridfs', 's3'],
    default: 'inline',
  },
  data: String,
}, { _id: false });

const quoteSchema = new mongoose.Schema({
  'user-id': {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  quoteId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    maxlength: 128,
  },
  scriptHash: { type: String, required: true },
  process: {
    type: String,
    required: true,
    enum: ['FDM', 'SLA', 'SLS', 'MJF'],
  },
  material: { type: String, required: true },
  infill: { type: Number, required: true, min: 10, max: 100 },
  'volume-mm3': { type: Number, required: true },
  'bounding-box': boundingBoxSchema,
  quotedAt: { type: Date, required: true },
  quotedUnitPrice: { type: Number, required: true },
  'unit-material': { type: Number, required: true },
  'unit-machine': { type: Number, required: true },
  'unit-grams': { type: Number, required: true },
  'model-file': modelFileSchema,
}, {
  collection: 'quotes',
});

// Same 7-day window as the cart line. Checkout also checks quotedAt so a
// document Mongo has not deleted yet is still treated as expired.
quoteSchema.index({ quotedAt: 1 }, { expireAfterSeconds: QUOTE_TTL_MS / 1000 });

const Quote = mongoose.model('Quote', quoteSchema);

export default Quote;
