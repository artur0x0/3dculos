// routes/orders.js - Order management routes
import { Router } from 'express';
import Order from '../db/models/Order.js';
import stripe from '../services/stripe.js';
import email from '../services/email.js';
import { calculateTax } from '../config/taxRates.js';
import { requireAuth, requireGuestOrAuth } from '../auth/session.js';

const router = Router();

/**
 * POST /api/orders/create
 * Create a new order and get payment intent
 */
router.post('/create', requireGuestOrAuth, async (req, res) => {
  try {
    const {
      modelData,
      quote,
      shipping,
    } = req.body;
    
    // Validate required fields
    if (!modelData || !modelData.script || !modelData.process || !modelData.material) {
      return res.status(400).json({ error: 'Model data is required' });
    }
    
    if (!quote || typeof quote.subtotal !== 'number') {
      return res.status(400).json({ error: 'Quote data is required' });
    }
    
    if (!shipping || !shipping.address || !shipping.method) {
      return res.status(400).json({ error: 'Shipping info is required' });
    }

    // Get state from address (handle both formats)
    const shippingState = shipping.address.state || shipping.address['state'];
    const shippingCountry = shipping.address.country || shipping.address['country'] || 'US';
    
    // Calculate tax based on shipping state
    const taxableAmount = quote.subtotal + (quote.shipping || 0);
    const { tax, rate: taxRate } = calculateTax(
      taxableAmount, 
      shippingState,
      shippingCountry
    );
    
    // Calculate final total
    const total = quote.subtotal + (quote.shipping || 0) + tax;

    // Map address to kebab-case (handle both incoming formats)
    const mappedAddress = {
      name: shipping.address.name,
      'address-1': shipping.address.street || shipping.address['address-1'],
      'address-2': shipping.address.street2 || shipping.address['address-2'] || '',
      city: shipping.address.city,
      state: shippingState,
      zip: shipping.address.zip,
      country: shippingCountry,
      phone: shipping.address.phone || '',
    };
    
    // Create order document with kebab-case fields
    const orderData = {
      'model-data': {
        script: modelData.script,
        process: modelData.process,
        material: modelData.material,
        infill: modelData.infill || 20,
        'volume-mm3': modelData.volume || modelData['volume-mm3'],
        'surface-area-mm2': modelData.surfaceArea || modelData['surface-area-mm2'],
        'bounding-box': modelData.boundingBox ? {
          'width-mm': modelData.boundingBox.width || modelData.boundingBox['width-mm'],
          'height-mm': modelData.boundingBox.height || modelData.boundingBox['height-mm'],
          'depth-mm': modelData.boundingBox.depth || modelData.boundingBox['depth-mm'],
        } : undefined,
        'model-file': {
          'content-type': modelData.modelFile.contentType || modelData.modelFile['content-type'],
          'filename': modelData.modelFile.filename || modelData.modelFile['filename'],
          'data': modelData.modelFile.data
        }
      },
      quote: {
        'material-cost': quote.material || quote['material-cost'],
        'machine-cost': quote.machine || quote['machine-cost'],
        subtotal: quote.subtotal,
        'shipping-cost': quote.shipping || quote['shipping-cost'] || 0,
        tax,
        'tax-rate': taxRate,
        total,
      },
      shipping: {
        address: mappedAddress,
        method: shipping.method,
        carrier: 'UPS',
        service: shipping.service,
        'estimated-delivery': shipping.estimatedDelivery || shipping['estimated-delivery'],
      },
      timeline: [{
        status: 'pending',
        timestamp: new Date(),
        note: 'Order created',
        actor: 'system',
      }],
    };

    console.log("[Orders] received order data: ", orderData)
    
    // Set user reference
    if (req.isAuthenticated()) {
      orderData['user-id'] = req.user._id;
    } else if (req.session.guestEmail) {
      orderData['guest-email'] = req.session.guestEmail;
      orderData['guest-session-id'] = req.session.guestId;
    } else {
      return res.status(400).json({ error: 'User or guest session required' });
    }
    
    // Add request metadata
    orderData.metadata = {
      'ip-address': req.ip,
      'user-agent': req.get('user-agent'),
    };
    
    const order = new Order(orderData);
    await order.save();
    
    console.log(`[Orders] Created order ${order['order-number']}`);
    
    // Create Stripe payment intent
    const customerEmail = req.user?.email || req.session.guestEmail;
    const { clientSecret, paymentIntentId } = await stripe.createPaymentIntent(order, {
      customerEmail,
    });
    
    // Store payment intent ID
    order.payment = { 'stripe-payment-intent-id': paymentIntentId };
    await order.save();
    
    return res.status(201).json({
      success: true,
      order: {
        id: order._id,
        orderNumber: order['order-number'],
        total: order.quote.total,
        tax: order.quote.tax,
      },
      clientSecret,
      publishableKey: stripe.getPublishableKey(),
    });
    
  } catch (error) {
    console.error('[Orders] Create error:', error);
    return res.status(500).json({ 
      error: 'Failed to create order',
      details: error.message,
    });
  }
});

/**
 * POST /api/orders/:orderId/confirm
 * Confirm order after successful payment
 */
router.post('/:orderId/confirm', requireGuestOrAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { paymentIntentId } = req.body;
    
    const order = await Order.findById(orderId);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    // Verify ownership
    if (req.isAuthenticated()) {
      if (order['user-id']?.toString() !== req.user._id.toString()) {
        return res.status(403).json({ error: 'Not authorized' });
      }
    } else if (order['guest-session-id'] !== req.session.guestId) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Verify payment intent matches
    if (order.payment?.['stripe-payment-intent-id'] !== paymentIntentId) {
      return res.status(400).json({ error: 'Payment intent mismatch' });
    }
    
    // Verify payment succeeded with Stripe
    const paymentIntent = await stripe.getPaymentIntent(paymentIntentId);
    
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ 
        error: 'Payment not completed',
        status: paymentIntent.status,
      });
    }
    
    // Update order status
    const paymentDetails = await stripe.handlePaymentSuccess(paymentIntent);
    
    // Map payment details to kebab-case
    order.payment = {
      ...order.payment,
      'stripe-payment-intent-id': paymentDetails.paymentIntentId,
      'stripe-customer-id': paymentDetails.customerId,
      method: paymentDetails.method,
      'card-last4': paymentDetails.last4,
      'card-brand': paymentDetails.brand,
      'paid-at': new Date(),
    };
    order.addTimelineEvent('paid', 'Payment received');
    await order.save();
    
    console.log(`[Orders] Order ${order['order-number']} confirmed and paid`);
    
    // Send confirmation emails (async, don't wait)
    const userEmail = req.user?.email || order['guest-email'];
    email.sendOrderConfirmation(order, userEmail).catch(console.error);
    email.sendAdminNotification(order, userEmail).catch(console.error);
    
    return res.json({
      success: true,
      order: {
        orderNumber: order['order-number'],
        status: order.status,
        total: order.quote.total,
      },
    });
    
  } catch (error) {
    console.error('[Orders] Confirm error:', error);
    return res.status(500).json({ 
      error: 'Failed to confirm order',
      details: error.message,
    });
  }
});

/**
 * GET /api/orders
 * Get user's orders
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const orders = await Order.findUserOrders(req.user._id);
    
    return res.json({
      success: true,
      orders,
    });
  } catch (error) {
    console.error('[Orders] List error:', error);
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

/**
 * GET /api/orders/:orderNumber
 * Get single order by order number
 */
router.get('/:orderNumber', async (req, res) => {
  try {
    const { orderNumber } = req.params;
    
    const order = await Order.findByOrderNumber(orderNumber);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    // Verify access
    if (req.isAuthenticated()) {
      if (order['user-id']?.toString() !== req.user._id.toString()) {
        return res.status(403).json({ error: 'Not authorized' });
      }
    } else {
      // Guests can look up their order by number + email
      const { email: guestEmail } = req.query;
      if (order['guest-email'] !== guestEmail?.toLowerCase()) {
        return res.status(403).json({ error: 'Email verification required' });
      }
    }
    
    return res.json({
      success: true,
      order,
    });
  } catch (error) {
    console.error('[Orders] Get error:', error);
    return res.status(500).json({ error: 'Failed to fetch order' });
  }
});

/**
 * GET /api/orders/lookup/:orderNumber
 * Guest order lookup by order number and email
 */
router.get('/lookup/:orderNumber', async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const { email: guestEmail } = req.query;
    
    if (!guestEmail) {
      return res.status(400).json({ error: 'Email is required for order lookup' });
    }
    
    const order = await Order.findByOrderNumber(orderNumber);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    // Verify email matches
    const orderEmail = order['guest-email'] || 
      (await order.populate('user-id'))['user-id']?.email;
    
    if (orderEmail !== guestEmail.toLowerCase()) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    return res.json({
      success: true,
      order: {
        orderNumber: order['order-number'],
        status: order.status,
        createdAt: order['created-at'],
        quote: order.quote,
        shipping: {
          method: order.shipping.method,
          service: order.shipping.service,
          'tracking-number': order.shipping['tracking-number'],
          'tracking-url': order.shipping['tracking-url'],
        },
        timeline: order.timeline,
      },
    });
  } catch (error) {
    console.error('[Orders] Lookup error:', error);
    return res.status(500).json({ error: 'Failed to lookup order' });
  }
});

export default router;
