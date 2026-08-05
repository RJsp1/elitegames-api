-- ELITE GAMES API — migration inicial (estrutura financeira Pix Sicredi)
-- PostgreSQL / Supabase — idempotente (pode ser reexecutada com segurança)
--
-- Escopo desta versão:
--   - somente payments e payment_events
--   - registrations fica a cargo do sistema de inscrições (Lovable)
--
-- Segurança:
--   - RLS ativo nas duas tabelas
--   - sem políticas públicas (select/insert/update/delete)
--   - o backend acessa via SUPABASE_SERVICE_ROLE_KEY
--   - a service_role ignora RLS e NUNCA deve ser exposta no frontend
--   - políticas para usuários autenticados serão criadas posteriormente

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Função de updated_at (idempotente)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_updated_at() IS
  'Atualiza updated_at automaticamente em BEFORE UPDATE. Usada pelo backend financeiro Elite Games.';

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id UUID NULL,
  txid TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  pix_copy_paste TEXT NULL,
  provider_charge_id TEXT NULL,
  end_to_end_id TEXT NULL,
  expires_at TIMESTAMPTZ NULL,
  paid_at TIMESTAMPTZ NULL,
  raw_response JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payments_txid_unique UNIQUE (txid),
  CONSTRAINT payments_end_to_end_id_unique UNIQUE (end_to_end_id),
  CONSTRAINT payments_amount_positive CHECK (amount > 0),
  CONSTRAINT payments_status_allowed CHECK (
    status IN (
      'pending',
      'active',
      'paid',
      'expired',
      'cancelled',
      'failed',
      'under_review',
      'refunded'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_payments_registration_id
  ON public.payments (registration_id);

CREATE INDEX IF NOT EXISTS idx_payments_status
  ON public.payments (status);

CREATE INDEX IF NOT EXISTS idx_payments_created_at
  ON public.payments (created_at DESC);

DROP TRIGGER IF EXISTS trg_payments_updated_at ON public.payments;

CREATE TRIGGER trg_payments_updated_at
BEFORE UPDATE ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.payments IS
  'Cobranças Pix Sicredi (Elite Games). Acesso pelo backend com SUPABASE_SERVICE_ROLE_KEY (ignora RLS). Service role nunca no frontend. Políticas para usuários autenticados virão depois.';

COMMENT ON COLUMN public.payments.registration_id IS
  'Referência opcional à inscrição ( Lovable ). Nullable nesta primeira versão.';

COMMENT ON COLUMN public.payments.txid IS
  'Identificador da cobrança Pix (26 caracteres alfanuméricos).';

COMMENT ON COLUMN public.payments.end_to_end_id IS
  'Identificador ponta a ponta do Pix liquidado (único quando presente).';

-- ---------------------------------------------------------------------------
-- payment_events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NULL REFERENCES public.payments (id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  external_event_id TEXT NULL,
  txid TEXT NULL,
  end_to_end_id TEXT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processing_error TEXT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_events_external_event_id_unique UNIQUE (external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_events_payment_id
  ON public.payment_events (payment_id);

CREATE INDEX IF NOT EXISTS idx_payment_events_processed
  ON public.payment_events (processed);

CREATE INDEX IF NOT EXISTS idx_payment_events_txid
  ON public.payment_events (txid);

CREATE INDEX IF NOT EXISTS idx_payment_events_received_at
  ON public.payment_events (received_at DESC);

ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.payment_events IS
  'Eventos brutos de webhook/conciliação Pix. Backend usa SUPABASE_SERVICE_ROLE_KEY (ignora RLS). Service role nunca no frontend. Políticas autenticadas serão criadas posteriormente.';

COMMENT ON COLUMN public.payment_events.external_event_id IS
  'Idempotência de eventos externos (quando o provedor enviar um id estável).';

COMMENT ON COLUMN public.payment_events.payload IS
  'Payload bruto sanitizado/persistido do webhook ou consulta ao provedor.';
