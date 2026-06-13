import express from 'express';
import dotenv from 'dotenv';
import { createOrder, verifyPayment } from './razorpay.handler.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4001;

app.use(express.json());

// CORS for local dev (Flutter web + mobile emulator). Tighten in production.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'dvenue-payments',
    razorpayKeyId: process.env.RAZORPAY_KEY_ID ? 'configured' : 'missing',
    supabase: process.env.SUPABASE_URL ? 'configured' : 'missing',
    firebaseProject: process.env.FIREBASE_PROJECT_ID || 'missing',
    port: PORT,
  });
});

/**
 * Create Razorpay order (secure server-side amount from Firebase)
 * Body: { type: 'booking' | 'advertisement' | 'premium', id: string, userId?: string, metadata?: object }
 */
app.post('/api/create-order', async (req, res) => {
  try {
    const { type, id, bookingId, listingId, userId, metadata } = req.body || {};

    const referenceId = id || bookingId || listingId;
    if (!referenceId) {
      return res.status(400).json({ ok: false, message: 'id, bookingId or listingId is required' });
    }

    const order = await createOrder({
      type: type || (bookingId ? 'booking' : 'advertisement'),
      id: referenceId,
      userId,
      metadata,
    });

    res.json({
      ok: true,
      message: 'Order created',
      order,
    });
  } catch (err) {
    console.error('create-order error:', err);
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({
      ok: false,
      message: err.message || 'Failed to create order',
    });
  }
});

/**
 * Verify payment signature + persist results
 * Body must include the three Razorpay fields + reference info
 */
app.post('/api/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      type,
      id,
      bookingId,
      listingId,
      userId,
    } = req.body || {};

    const referenceId = id || bookingId || listingId;

    const result = await verifyPayment({
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      type: type || 'booking',
      referenceId,
      userId,
    });

    res.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    console.error('verify-payment error:', err);
    const status = err.message.includes('signature') ? 400 : 500;
    res.status(status).json({
      ok: false,
      message: err.message || 'Payment verification failed',
    });
  }
});

// Convenience endpoint used by main backend proxy or direct calls
app.post('/api/payments/create-order', (req, res) => {
  // delegate to the same handler
  req.url = '/api/create-order';
  app.handle(req, res);
});

app.post('/api/payments/verify', (req, res) => {
  req.url = '/api/verify-payment';
  app.handle(req, res);
});

const server = app.listen(PORT, () => {
  console.log(`💳 Dvenue Payments server running on http://localhost:${PORT}`);
  console.log(`   Razorpay Key ID: ${process.env.RAZORPAY_KEY_ID ? 'rzp_test_***' : 'MISSING'}`);
  console.log(`   Supabase: ${process.env.SUPABASE_URL ? 'enabled' : 'disabled (no storage)'}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use.`);
    console.error('   Run "kill-servers.bat" (or double-click it) from the Dvenue root folder,');
    console.error('   then run "start.bat" again.\n');
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});
