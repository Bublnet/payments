import express from 'express';
import cors from 'cors';
import { createOrder, verifyPayment } from './razorpay.handler.js';
import { supabase } from './supabase.client.js';
import { db } from './firebase.config.js';

export function createPaymentsApp({ createOrder, verifyPayment, capturePaymentByReference }) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    const token = process.env.INTERNAL_SERVICE_TOKEN;
    if (token && req.path.startsWith('/api/') && req.get('X-Internal-Service-Token') !== token) {
      return res.status(401).json({ ok: false, message: 'Unauthorized service request.' });
    }
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'dvenue-payments' }));

  const createRoute = async (req, res) => {
    try {
      const { type, id, bookingId, listingId, userId, metadata } = req.body || {};
      const referenceId = id || bookingId || listingId;
      if (!referenceId) return res.status(400).json({ ok: false, message: 'id, bookingId or listingId is required' });
      const order = await createOrder({ type: type || (bookingId ? 'booking' : 'advertisement'), id: referenceId, userId, metadata });
      return res.json({ ok: true, message: 'Order created', order });
    } catch (error) {
      const message = error?.message || 'Failed to create order';
      return res.status(message.includes('not found') ? 404 : 400).json({ ok: false, message });
    }
  };
  const verifyRoute = async (req, res) => {
    try {
      const body = req.body || {};
      const result = await verifyPayment({
        razorpay_order_id: body.razorpay_order_id,
        razorpay_payment_id: body.razorpay_payment_id,
        razorpay_signature: body.razorpay_signature,
        type: body.type || 'booking',
        referenceId: body.id || body.bookingId || body.listingId,
        userId: body.userId,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const message = error?.message || 'Payment verification failed';
      return res.status(message.toLowerCase().includes('signature') || message.includes('Missing') ? 400 : 500).json({ ok: false, message });
    }
  };
  const captureRoute = async (req, res) => {
    try {
      const { referenceId, bookingId } = req.body || {};
      const ref = referenceId || bookingId;
      if (!ref) return res.status(400).json({ ok: false, message: 'referenceId is required' });
      const result = await capturePaymentByReference(ref);
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ ok: false, message: error.message || 'Capture failed' });
    }
  };

  app.post('/api/create-order', createRoute);
  app.post('/api/verify-payment', verifyRoute);
  app.post('/api/capture-payment', captureRoute);
  app.post('/api/payments/create-order', createRoute);
  app.post('/api/payments/verify', verifyRoute);
  app.post('/api/payments/capture', captureRoute);

  app.post('/api/venues/sync', async (req, res) => {
    try {
      const listing = req.body;
      if (!listing || !listing.id || !listing.pincode) {
        return res.status(400).json({ ok: false, message: 'Invalid listing data.' });
      }
      
      console.log(`[VENUE SYNC] Syncing approved venue ${listing.id} to payment database...`);
      
      // Upsert the synced listing into the payment server's Supabase database
      const { error } = await supabase
        .from('venues')
        .upsert(listing);
        
      if (error) throw error;
      
      if (db) {
        const prefix = String(listing.pincode).substring(0, 3);
        console.log(`[VENUE SYNC] Storing venue ${listing.id} in Firebase pincode structure: ${prefix}`);
        await db.collection(prefix).doc(listing.id).set(listing);
      } else {
        console.warn(`[VENUE SYNC] Firebase not configured, skipping pincode structure sync.`);
      }
      
      console.log(`[VENUE SYNC] Successfully synced venue ${listing.id}`);
      res.json({ ok: true, message: 'Venue synced successfully.' });
    } catch (error) {
      console.error('[VENUE SYNC] Failed to sync venue:', error);
      res.status(500).json({ ok: false, message: error.message });
    }
  });

  app.use((_req, res) => res.status(404).json({ ok: false, message: 'Route not found.' }));
  return app;
}
