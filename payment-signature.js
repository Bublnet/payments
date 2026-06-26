import crypto from 'crypto';

export function createPaymentSignature(orderId, paymentId, secret) {
  if (!orderId || !paymentId || !secret) {
    throw new Error('Order ID, payment ID, and Razorpay secret are required.');
  }
  return crypto.createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

export function signaturesMatch(expectedHex, receivedHex) {
  const expected = Buffer.from(String(expectedHex), 'utf8');
  const received = Buffer.from(String(receivedHex), 'utf8');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
