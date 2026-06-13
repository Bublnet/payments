import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn(
    '⚠️  Supabase credentials missing in env. Payments and subscription storage will be disabled or fail.'
  );
}

// Service role client (server only - full access, bypasses RLS)
export const supabase = createClient(supabaseUrl || '', supabaseServiceKey || '', {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Helper to check if Supabase is configured
export function isSupabaseConfigured() {
  return !!(supabaseUrl && supabaseServiceKey);
}

export default supabase;
