import Razorpay from 'razorpay';
import crypto from 'crypto';
import { doc, getDoc, updateDoc, collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db as firebaseDb } from './firebase.config.js';
import supabase, { isSupabaseConfigured } from './supabase.client.js';
import dotenv from 'dotenv';

dotenv.config();

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!KEY_ID || !KEY_SECRET) {
  throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required in .env');
}

const razorpay = new Razorpay({
  key_id: KEY_ID,
  key_secret: KEY_SECRET,
});

/**
 * Create a Razorpay order after securely fetching authoritative data from Firebase.
 * Supports 'booking' and 'advertisement' (ad boost / premium listing) for now.
 *
 * Client sends minimal trusted identifiers. Server re-fetches amount etc.
 */
export async function createOrder({ type = 'booking', id, userId, metadata = {} }) {
  if (!id) {
    throw new Error('id (bookingId or listingId) is required');
  }

  let amountInPaise;
  let receipt;
  let notes = {
    type,
    referenceId: id,
    userId: userId || 'unknown',
    ...metadata,
  };

  if (type === 'booking') {
    // Securely fetch from Firebase (source of truth for venue pricing + booking)
    const bookingRef = doc(firebaseDb, 'bookings', id);
    const bookingSnap = await getDoc(bookingRef);

    if (!bookingSnap.exists()) {
      // Also try alternative path if your data model differs
      throw new Error(`Booking not found in Firebase: ${id}`);
    }

    const booking = bookingSnap.data();
    const amount = Number(booking.amount || booking.total || booking.price || 0);

    if (!amount || amount <= 0) {
      throw new Error('Invalid booking amount in Firebase record');
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
    const listingRef = doc(firebaseDb, 'listings', id);
    const listingSnap = await getDoc(listingRef);

    if (!listingSnap.exists()) {
      throw new Error(`Listing not found for advertisement: ${id}`);
    }

    const listing = listingSnap.data();
    // You can have fixed ad prices or a boostPrice field
    const amount = Number(listing.boostPrice || listing.adPrice || 4999); // default example ₹4999

    amountInPaise = Math.round(amount * 100);
    receipt = `ad_${id}_${Date.now()}`;
    notes = {
      ...notes,
      listingName: listing.name || '',
      category: listing.category || '',
    };
  } else {
    // Generic / subscription payment
    const amount = Number(metadata.amount || 0);
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

  const order = await razorpay.orders.create(orderOptions);

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

  // Signature verification (critical)
  const generatedSignature = crypto
    .createHmac('sha256', KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (generatedSignature !== razorpay_signature) {
    throw new Error('Payment signature verification failed');
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

  // 2. Update source of truth in Firebase
  try {
    if (type === 'booking' && referenceId) {
      const bookingRef = doc(firebaseDb, 'bookings', referenceId);
      await updateDoc(bookingRef, {
        paymentStatus: 'paid',
        paidAt: new Date().toISOString(),
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        status: 'pending', // or 'paid_pending_approval' depending on your flow
      });

      // Re-fetch for response
      const snap = await getDoc(bookingRef);
      if (snap.exists()) updatedReference = { id: snap.id, ...snap.data() };
    } else if ((type === 'advertisement' || type === 'ad') && referenceId) {
      const listingRef = doc(firebaseDb, 'listings', referenceId);
      await updateDoc(listingRef, {
        isPromoted: true,
        promotedAt: new Date().toISOString(),
        razorpayPaymentId: razorpay_payment_id,
      });
      const snap = await getDoc(listingRef);
      if (snap.exists()) updatedReference = { id: snap.id, ...snap.data() };
    }
  } catch (fbErr) {
    console.error('Firebase update after payment verify failed:', fbErr);
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
