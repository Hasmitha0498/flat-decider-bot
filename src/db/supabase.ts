import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, requireEnv } from '../config';

let client: SupabaseClient | null = null;

/** Server-side Supabase client. Prefers the service role key; falls back to the anon key. */
export function db(): SupabaseClient {
  if (!client) {
    const key = env('SUPABASE_SERVICE_ROLE_KEY') ?? requireEnv('SUPABASE_ANON_KEY');
    client = createClient(requireEnv('SUPABASE_URL'), key, { auth: { persistSession: false } });
  }
  return client;
}

/** Thrown for any database problem so the bot can show one friendly message. */
export class DatabaseError extends Error {
  constructor(action: string, cause: { message?: string; code?: string } | null) {
    super(`Database error while trying to ${action}: ${cause?.message ?? 'unknown'}`);
    this.name = 'DatabaseError';
    this.code = cause?.code;
  }
  code?: string;
}
