import Razorpay from "razorpay";
import supabase, { isSupabaseConfigured } from "./supabase.client.js";
import dotenv from "dotenv";
import {
  createPaymentSignature,
  signaturesMatch,
} from "./payment-signature.js";

dotenv.config();

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

let razorpay;

function getRazorpay() {
  if (!KEY_ID || !KEY_SECRET) {
    throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required.");
  }
  razorpay ??= new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
  return razorpay;
}

function describeRazorpayError(error) {
  return {
    message:
      error?.message || error?.error?.description || "Unknown Razorpay error",
    statusCode: error?.statusCode || error?.status || error?.response?.status,
    code: error?.error?.code || error?.code,
    description: error?.error?.description,
    field: error?.error?.field,
    source: error?.error?.source,
    step: error?.error?.step,
    reason: error?.error?.reason,
  };
}

function makeReceipt(prefix, id) {
  const safePrefix = String(prefix || "pay")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 10);
  const safeId = String(id || "ref")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 16);
  const stamp = Date.now().toString(36);
  return `${safePrefix}_${safeId}_${stamp}`.slice(0, 40);
}

function toIsoFromRazorpaySeconds(value) {
  const parsed = Number(value || 0);
  if (!parsed) return null;
  return new Date(parsed * 1000).toISOString();
}

async function fetchRazorpayPaymentSafe(paymentId) {
  if (!paymentId) return null;
  try {
    return await getRazorpay().payments.fetch(paymentId);
  } catch (error) {
    console.warn(
      `[RAZORPAY PAYMENT FETCH WARNING] ${paymentId}: ${error?.message || error}`,
    );
    return null;
  }
}

/**
 * Create a Razorpay order after securely fetching authoritative data from Firebase.
 * Supports 'booking' and 'advertisement' (ad boost / premium listing) for now.
 *
 * Client sends minimal trusted identifiers. Server re-fetches amount etc.
 */
export async function createOrder({ type = "booking", id, userId, metadata }) {
  if (!id) {
    throw new Error("id (bookingId or listingId) is required");
  }

  const meta = metadata || {};

  let amountInPaise;
  let receipt;
  let notes = {
    type,
    referenceId: id,
    userId: userId || "unknown",
    ...meta,
  };

  if (type === "booking") {
    // Securely fetch from Supabase (source of truth for venue pricing + booking)
    console.log(
      `[PAYMENTS CREATE-ORDER] Fetching booking id=${id} from Supabase`,
    );
    const { data: booking, error } = await supabase
      .from("bookings")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error(
        `[PAYMENTS CREATE-ORDER ERROR] Supabase read failed for booking ${id}:`,
        error,
      );
    }

    if (error || !booking) {
      throw new Error(`Booking not found in database: ${id}`);
    }

    let amount = Number(booking.amount || booking.total || booking.price || 0);
    console.log(
      `[PAYMENTS CREATE-ORDER] Booking record from Supabase:`,
      JSON.stringify({
        id: booking.id,
        amount: booking.amount,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        eventDate: booking.eventDate,
      }),
    );
    console.log(
      `[PAYMENTS CREATE-ORDER] Raw amount from DB: ${amount}  |  metadata.payment_type: ${meta.payment_type || "none"}`,
    );

    if (!amount || amount <= 0) {
      throw new Error("Invalid booking amount in database record");
    }

    if (meta.payment_type === "reserve_20") {
      const full = amount;
      amount = amount * 0.2;
      console.log(
        `[PAYMENTS CREATE-ORDER] 20% reserve mode: full=${full} -> charging=${amount}`,
      );
    } else {
      console.log(
        `[PAYMENTS CREATE-ORDER] Full payment mode: charging=${amount}`,
      );
    }

    amountInPaise = Math.round(amount * 100);
    console.log(
      `[PAYMENTS CREATE-ORDER] Final charge: ₹${amount} = ${amountInPaise} paise`,
    );
    receipt = makeReceipt("booking", id);
    notes = {
      ...notes,
      venueId: booking.venueId || booking.venue_id || "",
      eventDate: booking.eventDate || booking.event_date || "",
      customerName: booking.customerName || "",
    };
  } else if (
    type === "advertisement" ||
    type === "ad" ||
    type === "premium_listing"
  ) {
    // For advertisement / premium boost on a listing
    const { data: listing, error } = await supabase
      .from("venues")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error || !listing) {
      throw new Error(`Venue not found for advertisement: ${id}`);
    }
    // You can have fixed ad prices or a boostPrice field
    const amount = Number(listing.boostPrice || listing.adPrice || 4999); // default example ₹4999

    amountInPaise = Math.round(amount * 100);
    receipt = makeReceipt("ad", id);
    notes = {
      ...notes,
      listingName: listing.name || "",
      category: listing.category || "",
    };
  } else if (type === "premium" || type === "subscription") {
    // Premium access / subscription purchase (amount from client metadata or default)
    const amount = Number(process.env.PREMIUM_MONTHLY_PRICE_INR || 299);
    if (!amount || amount < 1)
      throw new Error("amount (in rupees) required for premium purchase");
    amountInPaise = Math.round(amount * 100);
    receipt = makeReceipt("premium", id || Date.now());
    notes = { ...notes, plan: meta.plan || "monthly_access" };
  } else {
    // Generic / subscription payment
    const amount = Number(meta.amount || 0);
    if (!amount || amount < 1)
      throw new Error("amount (in rupees) required for this type");
    amountInPaise = Math.round(amount * 100);
    receipt = makeReceipt(type, id || Date.now());
  }

  if (amountInPaise < 100) {
    throw new Error("Amount must be at least ₹1.00 (100 paise)");
  }

  const orderOptions = {
    amount: amountInPaise,
    currency: "INR",
    receipt,
    notes,
    payment_capture: type === "booking" ? 0 : 1, // manual capture for bookings, auto capture for others
  };

  let order;
  try {
    order = await getRazorpay().orders.create(orderOptions);
  } catch (e) {
    const details = describeRazorpayError(e);
    console.error("[RAZORPAY CREATE-ORDER ERROR]", JSON.stringify(details));
    throw new Error(`Razorpay order creation failed: ${details.message}`);
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
  type = "booking",
  referenceId,
  userId,
}) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    throw new Error("Missing Razorpay payment verification fields");
  }

  // Signature verification (critical)
  const generatedSignature = createPaymentSignature(
    razorpay_order_id,
    razorpay_payment_id,
    KEY_SECRET,
  );

  if (!signaturesMatch(generatedSignature, razorpay_signature)) {
    throw new Error("Payment signature verification failed");
  }

  const razorpayPayment = await fetchRazorpayPaymentSafe(razorpay_payment_id);

  // Signature OK — now persist
  const paymentRecord = {
    provider: "razorpay",
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    type,
    reference_id: referenceId,
    user_id: userId || null,
    amount_paise: razorpayPayment?.amount || null,
    status: razorpayPayment?.status === "captured" ? "captured" : "paid",
    verified_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  let updatedReference = null;

  // 1. Store in Supabase (payments + subscription handling)
  if (isSupabaseConfigured()) {
    const { data: inserted, error } = await supabase
      .from("payments")
      .insert({
        ...paymentRecord,
        metadata: {
          type,
          referenceId,
          razorpay_status: razorpayPayment?.status || null,
          captured: razorpayPayment?.captured === true,
          fee_paise: razorpayPayment?.fee || null,
          tax_paise: razorpayPayment?.tax || null,
          method: razorpayPayment?.method || null,
        },
      })
      .select()
      .single();

    if (error) {
      console.error("Supabase payment insert error:", error);
      // Do not fail the whole verify if insert fails — signature was good
    }

    // Handle premium / subscription
    if (
      type === "premium" ||
      type === "subscription" ||
      type === "premium_listing"
    ) {
      if (userId) {
        await supabase
          .from("profiles") // or users / subscriptions table — adjust to your schema
          .update({
            is_premium: true,
            premium_since: new Date().toISOString(),
            last_payment_id: razorpay_payment_id,
          })
          .eq("id", userId);
      }
    }
  }

  // 2. Update source of truth in Supabase
  try {
    if (type === "booking" && referenceId) {
      const { data, error } = await supabase
        .from("bookings")
        .update({
          paymentStatus: "paid",
          paidAt: new Date().toISOString(),
          status: "pending", // or 'paid_pending_approval' depending on your flow
        })
        .eq("id", referenceId)
        .select()
        .single();

      if (!error && data) {
        updatedReference = data;
      } else if (error) {
        console.error("Error updating booking status:", error);
      }
    } else if ((type === "advertisement" || type === "ad") && referenceId) {
      console.log(
        `[PAYMENTS] Skipped venues table update for advertisement referenceId: ${referenceId} (columns not present in schema)`,
      );
      updatedReference = { id: referenceId, isPromoted: true };
    }
  } catch (dbErr) {
    console.error("Database update after payment verify failed:", dbErr);
  }

  return {
    success: true,
    message: "Payment verified and recorded successfully.",
    paymentId: razorpay_payment_id,
    orderId: razorpay_order_id,
    type,
    referenceId,
    updatedReference,
  };
}

export async function capturePaymentByReference(referenceId) {
  if (!referenceId) throw new Error("referenceId is required");

  if (!isSupabaseConfigured())
    throw new Error("Supabase is not configured to fetch payment details");

  const { data: payment, error } = await supabase
    .from("payments")
    .select("*")
    .eq("reference_id", referenceId)
    .single();

  if (error || !payment) {
    throw new Error(`Payment record not found for reference: ${referenceId}`);
  }

  const paymentId = payment.razorpay_payment_id;
  if (!paymentId)
    throw new Error("No razorpay_payment_id found in payment record");

  let rpPayment;
  try {
    rpPayment = await getRazorpay().payments.fetch(paymentId);
  } catch (e) {
    throw new Error(`Failed to fetch payment from Razorpay: ${e.message}`);
  }

  if (rpPayment.status === "captured") {
    return {
      success: true,
      message: "Payment was already captured",
      payment: rpPayment,
    };
  }

  if (rpPayment.status !== "authorized") {
    throw new Error(
      `Payment cannot be captured. Current status is '${rpPayment.status}'`,
    );
  }

  try {
    const captureResponse = await getRazorpay().payments.capture(
      paymentId,
      rpPayment.amount,
      rpPayment.currency,
    );
    await supabase
      .from("payments")
      .update({
        status: "captured",
        amount_paise: captureResponse.amount || rpPayment.amount || null,
        metadata: {
          ...(payment.metadata || {}),
          razorpay_status: captureResponse.status || "captured",
          captured: true,
          captured_at: new Date().toISOString(),
          fee_paise: captureResponse.fee || null,
          tax_paise: captureResponse.tax || null,
          method: captureResponse.method || rpPayment.method || null,
        },
      })
      .eq("id", payment.id);
    return {
      success: true,
      message: "Payment captured successfully",
      payment: captureResponse,
    };
  } catch (e) {
    throw new Error(`Razorpay capture failed: ${e.message}`);
  }
}

function periodStart(period = "month") {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  switch (period) {
    case "quarter": {
      const qStart = Math.floor(month / 3) * 3;
      return new Date(Date.UTC(year, qStart, 1)).toISOString();
    }
    case "year":
      return new Date(Date.UTC(year, 0, 1)).toISOString();
    case "all":
      return null;
    case "month":
    default:
      return new Date(Date.UTC(year, month, 1)).toISOString();
  }
}

function normalizePaymentRecord(record, razorpayPayment) {
  const amountPaise = Number(
    razorpayPayment?.amount || record.amount_paise || record.amount || 0,
  );
  const metadata = record.metadata || {};
  const feePaise = Number(razorpayPayment?.fee || metadata.fee_paise || 0);
  const taxPaise = Number(razorpayPayment?.tax || metadata.tax_paise || 0);
  const status =
    razorpayPayment?.status || metadata.razorpay_status || record.status || "unknown";
  const captured =
    razorpayPayment?.captured === true ||
    metadata.captured === true ||
    status === "captured";
  const createdAt =
    record.verified_at ||
    record.created_at ||
    toIsoFromRazorpaySeconds(razorpayPayment?.created_at) ||
    null;

  return {
    id: record.id,
    provider: record.provider || "razorpay",
    type: record.type || "booking",
    referenceId: record.reference_id || record.referenceId || null,
    userId: record.user_id || record.userId || null,
    orderId: record.razorpay_order_id || razorpayPayment?.order_id || null,
    paymentId: record.razorpay_payment_id || razorpayPayment?.id || null,
    status,
    captured,
    amountPaise,
    amount: amountPaise / 100,
    feePaise,
    fee: feePaise / 100,
    taxPaise,
    tax: taxPaise / 100,
    netPaise: Math.max(0, amountPaise - feePaise),
    net: Math.max(0, amountPaise - feePaise) / 100,
    method: razorpayPayment?.method || metadata.method || null,
    email: razorpayPayment?.email || null,
    contact: razorpayPayment?.contact || null,
    createdAt,
    capturedAt: metadata.captured_at || null,
    metadata,
    razorpay: razorpayPayment
      ? {
          vpa: razorpayPayment.vpa || null,
          cardId: razorpayPayment.card_id || null,
          wallet: razorpayPayment.wallet || null,
          bank: razorpayPayment.bank || null,
          acquirerData: razorpayPayment.acquirer_data || null,
        }
      : null,
  };
}

export async function listPaymentsForAdmin({ period = "month", limit = 200 } = {}) {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase is not configured to list payments");
  }

  const start = periodStart(period);
  let query = supabase
    .from("payments")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(Number(limit) || 200, 500)));

  if (start) query = query.gte("created_at", start);

  const { data, error } = await query;
  if (error) throw new Error(error.message || "Could not load payments");

  const payments = [];
  for (const record of data || []) {
    const rpPayment = await fetchRazorpayPaymentSafe(record.razorpay_payment_id);
    payments.push(normalizePaymentRecord(record, rpPayment));
  }

  const summary = payments.reduce(
    (acc, payment) => {
      acc.totalPayments += 1;
      acc.totalAmount += payment.amount;
      acc.totalFees += payment.fee;
      acc.netAmount += payment.net;
      if (payment.captured) {
        acc.capturedPayments += 1;
        acc.capturedAmount += payment.amount;
      } else if (payment.status === "authorized" || payment.status === "paid") {
        acc.authorizedPendingCapture += 1;
      } else if (payment.status === "failed") {
        acc.failedPayments += 1;
      }
      return acc;
    },
    {
      totalPayments: 0,
      capturedPayments: 0,
      authorizedPendingCapture: 0,
      failedPayments: 0,
      totalAmount: 0,
      capturedAmount: 0,
      totalFees: 0,
      netAmount: 0,
    },
  );

  return {
    period,
    generatedAt: new Date().toISOString(),
    summary,
    payments,
  };
}

export default {
  createOrder,
  verifyPayment,
  capturePaymentByReference,
  listPaymentsForAdmin,
};
