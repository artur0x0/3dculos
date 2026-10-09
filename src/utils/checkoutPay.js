/**
 * One Stripe confirm for the whole order. The PaymentIntent already
 * exists for the server total. This function does not create another one.
 */
import { readJsonSafe } from './quoteMath.js';

export async function confirmCheckoutPayment({
  stripe,
  elements,
  orderId,
  fetchImpl = fetch,
}) {
  if (!stripe || !elements) {
    throw new Error('Payment is not ready');
  }
  const { error, paymentIntent } = await stripe.confirmPayment({
    elements,
    confirmParams: {
      return_url: `${window.location.origin}/order/confirm`,
    },
    redirect: 'if_required',
  });
  if (error) {
    throw new Error(error.message || 'Payment failed');
  }
  if (!paymentIntent || paymentIntent.status !== 'succeeded') {
    throw new Error('Payment was not completed');
  }
  const response = await fetchImpl(`/api/orders/${orderId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ paymentIntentId: paymentIntent.id }),
  });
  const data = await readJsonSafe(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to confirm order');
  }
  return {
    orderNumber: data.order?.orderNumber,
    total: data.order?.total,
    status: data.order?.status,
    quantity: Number(data.order?.quantity) || null,
  };
}
