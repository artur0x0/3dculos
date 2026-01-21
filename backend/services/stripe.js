// services/stripe.js - Stripe payment integration (kebab-case schema)
import Stripe from 'stripe';
import config from '../config/index.js';

// Initialize Stripe
const stripe = config.stripe.secretKey 
  ? new Stripe(config.stripe.secretKey, { apiVersion: '2023-10-16' })
  : null;

/**
 * Create a Payment Intent for an order
 * @param {Object} order - Order document
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Payment intent with client secret
 */
export async function createPaymentIntent(order, options = {}) {
  if (!stripe) {
    throw new Error('Stripe not configured');
  }
  
  const { customerEmail, customerId } = options;
  
  // Amount must be in cents
  const amount = Math.round(order.quote.total * 100);
  
  // Get order number (handle both formats)
  const orderNumber = order['order-number'] || order.orderNumber;
  const modelData = order['model-data'] || order.modelData;
  
  const paymentIntentParams = {
    amount,
    currency: 'usd',
    automatic_payment_methods: {
      enabled: true,
    },
    metadata: {
      orderId: order._id.toString(),
      orderNumber: orderNumber,
    },
    description: `Order ${orderNumber} - ${modelData.process} ${modelData.material}`,
    receipt_email: customerEmail || order['guest-email'] || order.guestEmail,
  };
  
  // Attach to existing customer if available
  if (customerId) {
    paymentIntentParams.customer = customerId;
  }
  
  // Add shipping info for fraud prevention
  const shippingAddress = order.shipping?.address;
  if (shippingAddress) {
    paymentIntentParams.shipping = {
      name: shippingAddress.name,
      address: {
        line1: shippingAddress['address-1'] || shippingAddress.street,
        line2: shippingAddress['address-2'] || shippingAddress.street2 || '',
        city: shippingAddress.city,
        state: shippingAddress.state,
        postal_code: shippingAddress.zip,
        country: shippingAddress.country || 'US',
      },
    };
  }
  
  const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams);
  
  console.log(`[Stripe] Created PaymentIntent ${paymentIntent.id} for order ${orderNumber}`);
  
  return {
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
}

/**
 * Retrieve a Payment Intent
 */
export async function getPaymentIntent(paymentIntentId) {
  if (!stripe) throw new Error('Stripe not configured');
  return stripe.paymentIntents.retrieve(paymentIntentId);
}

/**
 * Create or get Stripe customer
 */
export async function getOrCreateCustomer(email, name = null) {
  if (!stripe) throw new Error('Stripe not configured');
  
  // Search for existing customer
  const customers = await stripe.customers.list({
    email,
    limit: 1,
  });
  
  if (customers.data.length > 0) {
    return customers.data[0];
  }
  
  // Create new customer
  return stripe.customers.create({
    email,
    name,
  });
}

/**
 * Process refund for an order
 */
export async function createRefund(paymentIntentId, amount = null, reason = 'requested_by_customer') {
  if (!stripe) throw new Error('Stripe not configured');
  
  const refundParams = {
    payment_intent: paymentIntentId,
    reason,
  };
  
  // Partial refund if amount specified
  if (amount) {
    refundParams.amount = Math.round(amount * 100);
  }
  
  const refund = await stripe.refunds.create(refundParams);
  console.log(`[Stripe] Created refund ${refund.id}`);
  
  return refund;
}

/**
 * Verify webhook signature
 */
export function verifyWebhookSignature(payload, signature) {
  if (!stripe) throw new Error('Stripe not configured');
  
  return stripe.webhooks.constructEvent(
    payload,
    signature,
    config.stripe.webhookSecret
  );
}

/**
 * Get Stripe publishable key for frontend
 */
export function getPublishableKey() {
  return config.stripe.publishableKey;
}

/**
 * Handle successful payment
 * Called from webhook or direct confirmation
 */
export async function handlePaymentSuccess(paymentIntent) {
  const { orderId } = paymentIntent.metadata;
  
  if (!orderId) {
    console.error('[Stripe] Payment success but no orderId in metadata');
    return null;
  }
  
  // Get payment method details
  let paymentMethod = null;
  if (paymentIntent.payment_method) {
    paymentMethod = await stripe.paymentMethods.retrieve(paymentIntent.payment_method);
  }
  
  return {
    orderId,
    paymentIntentId: paymentIntent.id,
    customerId: paymentIntent.customer,
    amount: paymentIntent.amount / 100,
    method: getPaymentMethodType(paymentMethod),
    last4: paymentMethod?.card?.last4,
    brand: paymentMethod?.card?.brand,
  };
}

/**
 * Determine payment method type
 */
function getPaymentMethodType(paymentMethod) {
  if (!paymentMethod) return 'card';
  
  const type = paymentMethod.type;
  const wallet = paymentMethod.card?.wallet?.type;
  
  if (wallet === 'apple_pay') return 'apple_pay';
  if (wallet === 'google_pay') return 'google_pay';
  return type || 'card';
}

export default {
  createPaymentIntent,
  getPaymentIntent,
  getOrCreateCustomer,
  createRefund,
  verifyWebhookSignature,
  getPublishableKey,
  handlePaymentSuccess,
};
