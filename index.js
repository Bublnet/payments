import dotenv from 'dotenv';
import { createPaymentsApp } from './app.js';
import { createOrder, verifyPayment } from './razorpay.handler.js';

dotenv.config();
const app = createPaymentsApp({ createOrder, verifyPayment });
const PORT = process.env.PORT || 4001;

if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => console.log(`Dvenue Payments server running on http://localhost:${PORT}`));
  server.on('error', (error) => {
    console.error('Payments server error:', error);
    process.exit(1);
  });
}

export default app;
