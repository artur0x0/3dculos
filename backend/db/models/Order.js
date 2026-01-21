// db/models/Order.js - Order schema matching business.orders
import mongoose from 'mongoose';
import crypto from 'crypto';

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
  'model-data': modelDataSchema,
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
    .select('-model-data.script -model-data.model-file');
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
    return ret;
  },
});

const Order = mongoose.model('Order', orderSchema);

export default Order;
