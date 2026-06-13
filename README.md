# Dvenue Payments Server

Dedicated microservice for all payments (Razorpay Standard Checkout).

- Creates Razorpay orders **after securely fetching pricing data from Firebase Firestore**.
- Verifies payment signatures.
- Stores payment records + subscription/premium status in **Supabase**.
- Updates booking / listing payment state back in **Firebase**.

## Quick Start (Recommended)

From the project root, simply double-click:

```bat
start.bat
```

**What `start.bat` does:**
- Automatically kills any previous processes using ports **4000** and **4001** (prevents `EADDRINUSE` errors)
- Opens two titled PowerShell windows:
  - `Dvenue Backend (4000)`
  - `Dvenue Payments (4001)`
- Live output + appends logs to `logs/backend.log` and `logs/payments.log`

If you ever get port conflicts, you can also run:

```bat
kill-servers.bat
```

Then run `start.bat` again.

### Manual Start (alternative)

```bash
# Terminal 1 - Payments (recommended first)
cd payments
cp .env.example .env   # fill keys
npm install
npm run dev

# Terminal 2 - Backend (gateway)
cd backend
npm run dev
```

> The root `start.bat` + `scripts/*.ps1` do exactly the above automatically in nicely titled windows with file logging.

Server runs on port **4001** by default (override with `PORT=...`).

You also need the main `backend` (port 4000) running because Flutter only talks to it.

## Testing the full flow (recommended order)

1. Start payments: `cd payments && npm run dev`
2. Start backend: `cd backend && npm run dev` (it will proxy to payments)
3. Run Flutter app (`flutter run`).
4. Go through a booking flow → pick date(s) → Proceed to pay → "Pay with Razorpay".
5. The app will:
   - Create booking record(s) (unpaid)
   - Call backend → payments → create real Razorpay order (server reads amount from your Firebase)
   - Open the Razorpay native / web checkout.
6. Use any Razorpay test card / UPI (see Razorpay docs for test instruments).
7. On success the signature is sent for verification. Payments server:
   - Validates HMAC
   - Writes to Supabase `payments`
   - Sets `is_premium` if it was a premium purchase
   - Updates the booking in Firebase (`paymentStatus: "paid"`)
8. Flutter receives success and shows the ticket(s).

## Files of note

- `index.js` — Express server + routes + CORS for dev
- `razorpay.handler.js` — core `createOrder` (secure Firebase read) + `verifyPayment` (HMAC + dual writes)
- `firebase.config.js` — same pattern as main backend
- `supabase.client.js` — service-role client for payments + premium flags
- `arch.md` — complete data flow + security model between all servers
- `prompts.txt` — original Razorpay integration spec + Dvenue adaptations

## .env (copy from .env.example)

Must contain the Razorpay test keys you were given plus your Supabase + Firebase details.

## Endpoints (used by main backend or Flutter via gateway)

- `GET  /health`
- `POST /api/create-order`
  - Body: `{ "type": "booking", "id": "<bookingId>", "userId": "..." }`
  - Or `{ "type": "advertisement", "id": "<listingId>" }`
- `POST /api/verify-payment`
  - Body: the three fields from Razorpay success + reference:
    `{ "razorpay_order_id", "razorpay_payment_id", "razorpay_signature", "type", "id" }`

## Environment

See `.env.example`. You must provide:

- Razorpay test/live keys (KEY_SECRET stays only on this server)
- Supabase URL + Service Role key (for payments + profiles.is_premium)
- Firebase web config (to read authoritative booking/listing amounts)

## Data Flow Summary (see arch.md)

Flutter → main-backend (4000) → payments (4001) → Razorpay + Supabase + Firebase (read + write back)

## Tables expected in Supabase (create via SQL or dashboard)

```sql
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  provider text,
  razorpay_order_id text,
  razorpay_payment_id text unique,
  razorpay_signature text,
  type text,
  reference_id text,
  user_id uuid,
  amount_paise integer,
  status text,
  metadata jsonb,
  verified_at timestamptz,
  created_at timestamptz default now()
);

-- For premium / subscriptions
alter table profiles add column if not exists is_premium boolean default false;
alter table profiles add column if not exists premium_since timestamptz;
alter table profiles add column if not exists last_payment_id text;
```

## Security Notes

- Amount is **never trusted from client**.
- KEY_SECRET never leaves this server.
- Signature verification is mandatory before any state change.
- Firebase reads give the ground truth for price.
- Supabase service role used only here (never expose to client).

## Next

See [arch.md](./arch.md) for the complete picture across backend, payments, Supabase, Firebase, and Razorpay.
