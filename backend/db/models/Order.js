// db/models/Order.js - Order schema matching business.orders
import mongoose from 'mongoose';
import crypto from 'crypto';
import { USER_ORDERS_SELECT } from '../../services/orderLines.js';

const boundingBoxSchema = new mongoose.Schema({
  'width-mm': { type: Number },
  'height-mm': { type: Number },
  'depth-mm': { type: Number },
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

const modelDataSchema = new mongoose.Schema({
  script: {
    type: String,
    required: true,
  },
  process: {
    type: String,
    required: true,
    enum: ['FDM', 'SLA', 'SLS', 'MJF'],
  },
  material: {
    type: String,
    required: true,
  },
  infill: {
    type: Number,
    required: true,
    min: 10,
    max: 100,
  },
  'volume-mm3': {
    type: Number,
    required: true,
  },
  'surface-area-mm2': {
    type: Number,
  },
  'bounding-box': boundingBoxSchema,
  'model-file': modelFileSchema,
  // Copies of this one part. Old documents omit it; readers use
  // `Number(modelData.quantity) || 1`. The default does not backfill a raw read.
  quantity: {
    type: Number,
    default: 1,
    min: 1,
    max: 999,
  },
}, { _id: false });

const quoteSchema = new mongoose.Schema({
  'material-cost': {
    type: Number,
    required: true,
  },
  'machine-cost': {
    type: Number,
    required: true,
  },
  subtotal: {
    type: Number,
    required: true,
  },
  'shipping-cost': {
    type: Number,
    required: true,
  },
  tax: {
    type: Number,
    default: 0,
  },
  'tax-rate': {
    type: Number,
    default: 0,
  },
  total: {
    type: Number,
    required: true,
  },
}, { _id: false });

const addressSchema = new mongoose.Schema({
  name: { type: String, required: true },
  'address-1': { type: String, required: true },
  'address-2': String,
  city: { type: String, required: true },
  state: { type: String, required: true },
  zip: { type: String, required: true },
  country: { type: String, default: 'US' },
  phone: String,
}, { _id: false });

const shippingSchema = new mongoose.Schema({
  address: addressSchema,
  method: {
    type: String,
    enum: ['ground', '2day', 'overnight'],
    required: true,
  },
  carrier: {
    type: String,
    default: 'UPS',
  },
  service: String,
  'tracking-number': String,
  'tracking-url': String,
  'estimated-delivery': Date,
  'shipped-at': Date,
  'delivered-at': Date,
  // How many UPS boxes this order was rated as. Old documents omit it.
  'package-count': { type: Number, min: 1 },
}, { _id: false });

const billingSchema = new mongoose.Schema({
  address: addressSchema,
}, { _id: false });

const paymentSchema = new mongoose.Schema({
  'stripe-payment-intent-id': String,
  'stripe-customer-id': String,
  method: {
    type: String,
    enum: ['card', 'apple_pay', 'google_pay'],
  },
  'card-last4': String,
  'card-brand': String,
  'paid-at': Date,
  'refunded-at': Date,
  'refund-amount': Number,
}, { _id: false });

const timelineEventSchema = new mongoose.Schema({
  status: String,
  timestamp: { type: Date, default: Date.now },
  note: String,
  actor: {
    type: String,
    enum: ['system', 'admin', 'customer'],
    default: 'system',
  },
}, { _id: false });

const orderLineSchema = new mongoose.Schema({
  lineId: { type: String, required: true },
  partName: String,
  assemblyName: String,
  partId: String,
  source: String,
  surfId: String,
  scriptHash: String,
  quoteId: String,
  process: {
    type: String,
    required: true,
    enum: ['FDM', 'SLA', 'SLS', 'MJF'],
  },
  material: { type: String, required: true },
  infill: { type: Number, required: true, min: 10, max: 100 },
  quantity: { type: Number, required: true, min: 1, max: 999 },
  'volume-mm3': { type: Number, required: true },
  'bounding-box': boundingBoxSchema,
  'unit-subtotal': { type: Number, required: true },
  'material-cost': { type: Number, required: true },
  'machine-cost': { type: Number, required: true },
  'model-file': modelFileSchema,
});

const orderSchema = new mongoose.Schema({
  'order-number': {
    type: String,
    unique: true,
    required: true,
    index: true,
  },
  'user-id': {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  'guest-email': {
    type: String,
    lowercase: true,
    trim: true
  },
  'guest-session-id': String,
  status: {
    type: String,
    enum: [
      'pending',
      'paid',
      'processing',
      'quality-check',
      'shipped',
      'delivered',
      'cancelled',
      'refunded',
    ],
    default: 'pending',
    index: true,
  },
  // Required for a single-part order. Omitted when `lines` is non-empty.
  'model-data': {
    type: modelDataSchema,
    required: function modelDataRequired() {
      return !Array.isArray(this.lines) || this.lines.length === 0;
    },
  },
  // 20 lines per order keeps N inline 3MFs inside the 10mb JSON body.
  // Expand in future. The cap is enforced on create, not as a schema max.
  lines: {
    type: [orderLineSchema],
    default: undefined,
  },
  quote: quoteSchema,
  shipping: shippingSchema,
  billing: billingSchema,
  payment: paymentSchema,
  timeline: [timelineEventSchema],
  notes: {
    customer: String,
    internal: String,
  },
  metadata: {
    'ip-address': String,
    'user-agent': String,
    'idempotency-key': String,
  },
}, {
  timestamps: {
    createdAt: 'created-at',
    updatedAt: 'updated-at',
  },
  collection: 'orders',
});

// Indexes
orderSchema.index({ 'created-at': -1 });
orderSchema.index({ 'payment.stripe-payment-intent-id': 1 }, { sparse: true });
orderSchema.index({ 'guest-email': 1 }, { sparse: true });
orderSchema.index({ 'metadata.idempotency-key': 1 }, { unique: true, sparse: true });

// Pre-validate: Generate order number if not set
orderSchema.pre('validate', async function(next) {
  if (!this['order-number']) {
    this['order-number'] = await generateOrderNumber();
  }
  next();
});

// Generate unique order number: ORD-YYYYMM-0001AB
async function generateOrderNumber() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `ORD-${year}${month}`;
  
  const count = await mongoose.model('Order').countDocuments({
    'order-number': { $regex: `^${prefix}` }
  });
  
  const sequence = String(count + 1).padStart(4, '0');
  const random = crypto.randomBytes(2).toString('hex').toUpperCase();
  
  return `${prefix}-${sequence}${random}`;
}

// Instance method: Add timeline event
orderSchema.methods.addTimelineEvent = function(status, note = null, actor = 'system') {
  this.timeline.push({
    status,
    timestamp: new Date(),
    note,
    actor,
  });
  this.status = status;
  return this;
};

// Instance method: Mark as paid
orderSchema.methods.markPaid = function(paymentDetails) {
  this.payment = {
    ...this.payment?.toObject?.() || {},
    ...paymentDetails,
    'paid-at': new Date(),
  };
  this.addTimelineEvent('paid', 'Payment received');
  return this;
};

// Instance method: Mark as shipped
orderSchema.methods.markShipped = function(trackingNumber, trackingUrl) {
  this.shipping['tracking-number'] = trackingNumber;
  this.shipping['tracking-url'] = trackingUrl;
  this.shipping['shipped-at'] = new Date();
  this.addTimelineEvent('shipped', `Tracking: ${trackingNumber}`);
  return this;
};

// Static method: Find by order number
orderSchema.statics.findByOrderNumber = function(orderNumber) {
  return this.findOne({ 'order-number': orderNumber.toUpperCase() });
};

// Static method: Find user's orders
orderSchema.statics.findUserOrders = function(userId, limit = 20) {
  return this.find({ 'user-id': userId })
    .sort({ 'created-at': -1 })
    .limit(limit)
    .select(USER_ORDERS_SELECT);
};

// Virtual: User email (from user or guest)
orderSchema.virtual('user-email').get(function() {
  return this['guest-email'] || this.populated('user-id')?.email;
});

// Transform for JSON
orderSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    delete ret.__v;
    if (ret['model-data']) {
      delete ret['model-data'].script;
      delete ret['model-data']['model-file'];
    }
    if (Array.isArray(ret.lines)) {
      ret.lines = ret.lines.map((line) => {
        if (!line || typeof line !== 'object') return line;
        const copy = { ...line };
        delete copy['model-file'];
        return copy;
      });
    }
    return ret;
  },
});

const Order = mongoose.model('Order', orderSchema);

export default Order;
