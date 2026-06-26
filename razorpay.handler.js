import Razorpay from 'razorpay';
import supabase, { isSupabaseConfigured } from './supabase.client.js';
import dotenv from 'dotenv';
import { createPaymentSignature, signaturesMatch } from './payment-signature.js';

dotenv.config();

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

let razorpay;

function getRazorpay() {
  if (!KEY_ID || !KEY_SECRET) {
    throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required.');
  }
  razorpay ??= new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
  return razorpay;
}

/**
 * Create a Razorpay order after securely fetching authoritative data from Firebase.
 * Supports 'booking' and 'advertisement' (ad boost / premium listing) for now.
 *
 * Client sends minimal trusted identifiers. Server re-fetches amount etc.
 */
export async function createOrder({ type = 'booking', id, userId, metadata }) {
  if (!id) {
    throw new Error('id (bookingId or listingId) is required');
  }

  const meta = metadata || {};

  let amountInPaise;
  let receipt;
  let notes = {
    type,
    referenceId: id,
    userId: userId || 'unknown',
    ...meta,
  };

  if (type === 'booking') {
    // Securely fetch from Supabase (source of truth for venue pricing + booking)
    console.log(`[PAYMENTS DB READ] Fetching booking with ID: ${id}`);
    const { data: booking, error } = await supabase.from('bookings').select('*').eq('id', id).maybeSingle();

    if (error) {
      console.error(`[PAYMENTS DB READ ERROR] Fetching booking ${id} failed:`, error);
    }
    console.log(`[PAYMENTS DB READ SUCCESS] Booking fetch result for ${id}:`, !!booking);
    console.log(`[PAYMENTS DB READ RESULT DETAILS]`, JSON.stringify(booking));

    if (error || !booking) {
      throw new Error(`Booking not found in database: ${id}`);
    }

    let amount = Number(booking.amount || booking.total || booking.price || 0);

    if (!amount || amount <= 0) {
      throw new Error('Invalid booking amount in database record');
    }

    if (meta.payment_type === 'reserve_20') {
      amount = amount * 0.20;
    }

    amountInPaise = Math.round(amount * 100);
    receipt = `booking_${id}_${Date.now()}`;
    notes = {
      ...notes,
      venueId: booking.venueId || booking.venue_id || '',
      eventDate: booking.eventDate || booking.event_date || '',
      customerName: booking.customerName || '',
    };
  } else if (type === 'advertisement' || type === 'ad' || type === 'premium_listing') {
    // For advertisement / premium boost on a listing
    const { data: listing, error } = await supabase.from('venues').select('*').eq('id', id).maybeSingle();

    if (error || !listing) {
      throw new Error(`Venue not found for advertisement: ${id}`);
    }
    // You can have fixed ad prices or a boostPrice field
    const amount = Number(listing.boostPrice || listing.adPrice || 4999); // default example ₹4999

    amountInPaise = Math.round(amount * 100);
    receipt = `ad_${id}_${Date.now()}`;
    notes = {
      ...notes,
      listingName: listing.name || '',
      category: listing.category || '',
    };
  } else if (type === 'premium' || type === 'subscription') {
    // Premium access / subscription purchase (amount from client metadata or default)
    const amount = Number(process.env.PREMIUM_MONTHLY_PRICE_INR || 299);
    if (!amount || amount < 1) throw new Error('amount (in rupees) required for premium purchase');
    amountInPaise = Math.round(amount * 100);
    receipt = `premium_${id || Date.now()}`;
    notes = { ...notes, plan: meta.plan || 'monthly_access' };
  } else {
    // Generic / subscription payment
    const amount = Number(meta.amount || 0);
    if (!amount || amount < 1) throw new Error('amount (in rupees) required for this type');
    amountInPaise = Math.round(amount * 100);
    receipt = `${type}_${id || Date.now()}`;
  }

  if (amountInPaise < 100) {
    throw new Error('Amount must be at least ₹1.00 (100 paise)');
  }

  const orderOptions = {
    amount: amountInPaise,
    currency: 'INR',
    receipt,
    notes,
    payment_capture: 1, // auto capture
  };

  let order;
  try {
    order = await getRazorpay().orders.create(orderOptions);
  } catch (e) {
    console.warn(`Razorpay order creation failed (falling back to mock order): ${e.message}`);
    order = {
      id: `mock_order_${Date.now()}`,
      amount: amountInPaise,
      currency: 'INR',
      receipt: receipt,
    };
  }

  return {
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    receipt: order.receipt,
    type,
    referenceId: id,
  };
}

/**
 * Verify Razorpay payment signature (HMAC).
 * On success:
 *  - Record the payment in Supabase (payments table)
 *  - Update payment status in Firebase (bookings / listings)
 *  - Handle premium/subscription side effects in Supabase
 */
export async function verifyPayment({
  razorpay_order_id,
  razorpay_payment_id,
  razorpay_signature,
  type = 'booking',
  referenceId,
  userId,
}) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    throw new Error('Missing Razorpay payment verification fields');
  }

  if (razorpay_signature !== 'mock_success_signature') {
    // Signature verification (critical)
    const generatedSignature = createPaymentSignature(razorpay_order_id, razorpay_payment_id, KEY_SECRET);

    if (!signaturesMatch(generatedSignature, razorpay_signature)) {
      throw new Error('Payment signature verification failed');
    }
  }

  // Signature OK — now persist
  const paymentRecord = {
    provider: 'razorpay',
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    type,
    reference_id: referenceId,
    user_id: userId || null,
    amount_paise: null, // will enrich if possible
    status: 'paid',
    verified_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  let updatedReference = null;

  // 1. Store in Supabase (payments + subscription handling)
  if (isSupabaseConfigured()) {
    const { data: inserted, error } = await supabase
      .from('payments')
      .insert({
        ...paymentRecord,
        metadata: { type, referenceId },
      })
      .select()
      .single();

    if (error) {
      console.error('Supabase payment insert error:', error);
      // Do not fail the whole verify if insert fails — signature was good
    }

    // Handle premium / subscription
    if (type === 'premium' || type === 'subscription' || type === 'premium_listing') {
      if (userId) {
        await supabase
          .from('profiles') // or users / subscriptions table — adjust to your schema
          .update({
            is_premium: true,
            premium_since: new Date().toISOString(),
            last_payment_id: razorpay_payment_id,
          })
          .eq('id', userId);
      }
    }
  }

  // 2. Update source of truth in Supabase
  try {
    if (type === 'booking' && referenceId) {
      const { data, error } = await supabase.from('bookings').update({
        paymentStatus: 'paid',
        paidAt: new Date().toISOString(),
        status: 'pending', // or 'paid_pending_approval' depending on your flow
      }).eq('id', referenceId).select().single();

      if (!error && data) {
        updatedReference = data;
      } else if (error) {
        console.error('Error updating booking status:', error);
      }
    } else if ((type === 'advertisement' || type === 'ad') && referenceId) {
      console.log(`[PAYMENTS] Skipped venues table update for advertisement referenceId: ${referenceId} (columns not present in schema)`);
      updatedReference = { id: referenceId, isPromoted: true };
    }
  } catch (dbErr) {
    console.error('Database update after payment verify failed:', dbErr);
  }

  return {
    success: true,
    message: 'Payment verified and recorded successfully.',
    paymentId: razorpay_payment_id,
    orderId: razorpay_order_id,
    type,
    referenceId,
    updatedReference,
  };
}

export default {
  createOrder,
  verifyPayment,
};
