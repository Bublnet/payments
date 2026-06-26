import express from 'express';
export function createPaymentsApp({ createOrder, verifyPayment }) {
  const app = express();
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
  app.post('/api/create-order', createRoute);
  app.post('/api/verify-payment', verifyRoute);
  app.post('/api/payments/create-order', createRoute);
  app.post('/api/payments/verify', verifyRoute);

  app.post('/api/venues/sync', async (req, res) => {
    try {
      const listing = req.body;
      if (!listing || !listing.id || !listing.pincode) {
        return res.status(400).json({ ok: false, message: 'Invalid listing data.' });
      }
      const pincode = String(listing.pincode);
      const id = listing.id;
      
      res.json({ ok: true, message: 'Venue synced successfully (no-op via Supabase).' });
    } catch (error) {
      console.error('Failed to sync venue to Firebase:', error);
      res.status(500).json({ ok: false, message: error.message });
    }
  });

  app.use((_req, res) => res.status(404).json({ ok: false, message: 'Route not found.' }));
  return app;
}
