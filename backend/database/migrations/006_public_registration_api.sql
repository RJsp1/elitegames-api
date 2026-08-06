-- ELITE GAMES API — suporte à API pública de inscrição
-- PostgreSQL / Supabase — NÃO executar automaticamente.
--
-- Escopo:
--   1) Tokens temporários de acesso à inscrição (somente hash)
--   2) Idempotência de criação pública por request_id
--
-- Observação de schema:
--   events / categories / price_batches / athletes / registrations
--   são tipicamente do domínio Lovable. Esta migration NÃO os recria.
--   Ajuste as colunas no backend se o schema Lovable divergir.

-- ---------------------------------------------------------------------------
-- registration_access_tokens
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.registration_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id UUID NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT registration_access_tokens_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_registration_access_tokens_registration_id
  ON public.registration_access_tokens (registration_id);

CREATE INDEX IF NOT EXISTS idx_registration_access_tokens_expires_at
  ON public.registration_access_tokens (expires_at);

COMMENT ON TABLE public.registration_access_tokens IS
  'Tokens opacos de acesso público à inscrição. Armazena apenas hash SHA-256.';

-- ---------------------------------------------------------------------------
-- public_idempotency_keys
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.public_idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  response_snapshot JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT public_idempotency_keys_scope_request_unique UNIQUE (scope, request_id)
);

CREATE INDEX IF NOT EXISTS idx_public_idempotency_keys_created_at
  ON public.public_idempotency_keys (created_at DESC);

COMMENT ON TABLE public.public_idempotency_keys IS
  'Idempotência da API pública (ex.: criação de inscrição por X-Request-Id / requestId).';

-- ---------------------------------------------------------------------------
-- Índices sugeridos no catálogo Lovable (seguros se as tabelas existirem)
-- ---------------------------------------------------------------------------
-- CREATE INDEX IF NOT EXISTS idx_events_slug ON public.events (slug);
-- CREATE INDEX IF NOT EXISTS idx_categories_event_id ON public.categories (event_id);
