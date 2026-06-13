# Dvenue Architecture — Servers, Data Flow & API Calls

## Overview of Services

| Service       | Folder     | Port (dev) | Role |
|---------------|------------|------------|------|
| Flutter App   | dvenue_app | —          | Mobile + Web client. Talks **only** to main backend. |
| Main Backend (Gateway) | backend   | 4000       | Auth proxy (Supabase OTP), booking CRUD proxy, payment proxy, Firebase reads/writes for core data. |
| Payments      | payments   | 4001       | **Razorpay order creation + signature verification**. Secure price fetch from Firebase, write payment records + premium flags to Supabase, update booking/listing state in Firebase. |
| Supabase      | External   | —          | User profiles, OTP/auth, `payments` table, `subscriptions` / `is_premium` on profiles. |
| Firebase      | External   | —          | Primary source of truth for **listings/venues** and **bookings** (amounts, dates, ownership). Firestore. |
| Razorpay      | External   | —          | Payment gateway. Orders + payments. Standard Checkout flow. |

## High Level Payment Flow (Booking Example)

1. **User in Flutter**
   - Opens BookingFlowSheet → selects dates → "Proceed to pay" → "Pay now".
   - Currently calls `BookingsApi.createBooking(...)` then `payBooking(bookingId)` (hits main backend).

2. **Main Backend (4000) — acts as gateway**
   - Receives `/bookings` and `/bookings/:id/pay`.
   - For creation: writes initial booking (unpaid) to Firebase (or forwards).
   - For payment: calls (proxies) the Payments service `POST /api/create-order` with `{type: "booking", id: bookingId, userId}`.
   - Returns the Razorpay `order_id`, `amount`, `currency` to Flutter.

3. **Flutter — opens checkout**
   - Receives order from backend.
   - **Mobile**: Uses `razorpay_flutter` package → `Razorpay().open({ key: RAZORPAY_KEY_ID (public only), order_id, amount, ... })`
   - **Web (Flutter web)**: Either use package web support or inject https://checkout.razorpay.com/v1/checkout.js and call `new Razorpay(options).open()`.
   - User completes UPI/Card/Netbanking inside the Razorpay modal.

4. **On success callback in Flutter**
   - Receives: `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature`.
   - Immediately calls main backend → payments: `POST /api/verify-payment` (or `/api/payments/verify`) with those three fields + `bookingId` + `userId`.

5. **Payments Server (4001) — the security boundary**
   - **Verify signature**:
     ```
     HMAC-SHA256( order_id + "|" + payment_id , RAZORPAY_KEY_SECRET )
     ```
     Must match `razorpay_signature`. Reject on mismatch (400, do NOT mark paid).
   - On success:
     - Insert row into Supabase `payments` table (full audit trail).
     - If type === premium/subscription → set `profiles.is_premium = true`, `premium_since`, `last_payment_id`.
     - Update the booking document in **Firebase Firestore**:
       - `paymentStatus: "paid"`
       - `paidAt`, `razorpay*` ids, possibly flip `status` to "pending" (staff approval next).
   - Return success to the chain → Flutter shows ticket.

6. **Advertisement / Premium Listing flow** (same servers)
   - Client sends `{ type: "advertisement", id: listingId }`.
   - Payments server fetches listing from Firebase `listings` collection to get authoritative boost price.
   - Same create → checkout → verify path.
   - On success: sets `isPromoted: true` on the listing + payment record in Supabase.

## Why separate "payments" server?

- Keeps **KEY_SECRET** completely isolated (never on main backend, never in Flutter).
- Single place that talks to Razorpay + has both Supabase service-role + Firebase.
- Easy to scale, deploy, or replace (e.g. move to serverless).
- Main backend stays focused on orchestration + other proxies (Supabase OTP, etc.).

## API Contracts (between layers)

### Flutter → Main Backend (current contract)
All calls go through `ApiConfig.apiRoot` (http://localhost:4000/api or production).

Relevant for payments:
- `POST /bookings` → create unpaid booking
- `POST /bookings/:bookingId/pay` → triggers the whole payment flow (in real impl this becomes the "start payment" that internally creates order)

Future / recommended:
- Add explicit payment endpoints on main backend that forward:
  - `POST /api/payments/create-order`
  - `POST /api/payments/verify`

### Main Backend → Payments (internal, localhost or same private network)
The main backend should perform simple HTTP POSTs to `http://localhost:4001` (or env var `PAYMENTS_SERVICE_URL`).

Example (pseudo in Express):
```js
app.post('/bookings/:id/pay', async (req, res) => {
  // ... auth ...
  const createRes = await fetch('http://localhost:4001/api/create-order', {
    method: 'POST',
    body: JSON.stringify({ type: 'booking', id: req.params.id, userId: req.user.id })
  });
  const order = await createRes.json();
  // return order to Flutter so it can open Razorpay
});
```

Same for verify after client success.

### Payments → External

**Razorpay**
- `POST https://api.razorpay.com/v1/orders` (via official `razorpay` SDK)
- Signature verification is local (HMAC, no extra network call needed for basic security).

**Firebase (Firestore)**
- Read: `doc(db, 'bookings', id)` or `listings`
- Write (after verify only): `updateDoc(...)` for paymentStatus / paidAt / isPromoted

**Supabase**
- `supabase.from('payments').insert(...)`
- `supabase.from('profiles').update({ is_premium: true, ... })`

## Environment Variable Rules (strict)

- `RAZORPAY_KEY_SECRET` → **payments server only**. Never in frontend, never in main backend .env if possible.
- `RAZORPAY_KEY_ID` → can be exposed to Flutter (via main backend config or compile-time for web) for opening the checkout modal.
- Supabase **service role key** → payments only.
- Firebase web config → safe to duplicate in backend/ and payments/ (client SDK rules still apply on reads/writes from these servers).

## Current State (as of implementation)

- `backend/` has basic Firebase init + Express skeleton. Needs real `/bookings` + proxy to payments.
- `payments/` fully implements the two critical Razorpay endpoints + secure fetch + dual write (Supabase + Firebase).
- Flutter payment flow is still in "demo mode" text. Real integration requires:
  1. Adding `razorpay_flutter` package.
  2. Wiring create-order + open checkout + verify calls (through main backend recommended).
  3. Replacing the simulated `_createAndPay` with the real async sequence.

## Recommended Table Schemas (Supabase)

See payments/README.md for the SQL.

## Security & Compliance Highlights

- Amount always re-fetched server-side from Firebase before creating Razorpay order.
- Signature mismatch → hard reject, no state change.
- All money movement audited in Supabase `payments`.
- Premium flag only flipped after successful verified payment.
- In production use Firebase Admin SDK (service account JSON) instead of web client config for payments server (higher privileges, bypasses rules cleanly).
- Add proper auth (JWT from your session) on the payment endpoints in production.

## Deployment Notes

- Main backend and payments can be separate services (Vercel, Railway, Fly, Render, etc.).
- Set `PAYMENTS_SERVICE_URL` in main backend pointing at the payments deployment.
- Use live Razorpay keys only after testing thoroughly with test cards/UPI.
- Webhook support from Razorpay can be added later in payments for extra reliability (currently we rely on client success callback + verify).

This document + the code in `payments/razorpay.handler.js` + `index.js` is the single source of truth for how money and state move in Dvenue.
