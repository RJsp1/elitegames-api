import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from './env.js';
import { logger } from '../utils/logger.js';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  const env = getEnv();

  // Modo mock: persistência em memória, a menos que USE_SUPABASE_WITH_MOCK=true.
  // Evita que testes/dev com .env preenchido gravem no banco real sem querer.
  if (env.isMock && process.env.USE_SUPABASE_WITH_MOCK !== 'true') {
    return null;
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    if (!env.isMock) {
      logger.warn('Supabase não configurado');
    }
    return null;
  }

  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return client;
}

export function resetSupabaseClient(): void {
  client = null;
}
