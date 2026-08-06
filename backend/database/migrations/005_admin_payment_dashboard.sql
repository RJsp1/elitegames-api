-- ELITE GAMES API — índices de suporte ao dashboard admin Pix
-- PostgreSQL / Supabase — NÃO executar automaticamente.
--
-- Objetivo: acelerar listagens/filtros do painel administrativo.
-- Sem alteração de regras financeiras.

CREATE INDEX IF NOT EXISTS idx_payments_status_created_at
  ON public.payments (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_registration_created_at
  ON public.payments (registration_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_paid_at
  ON public.payments (paid_at DESC)
  WHERE paid_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_charges_payment_created_at
  ON public.payment_charges (payment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_created_at
  ON public.audit_logs (entity_id, created_at DESC)
  WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created_at
  ON public.audit_logs (action, created_at DESC);

COMMENT ON INDEX public.idx_payments_status_created_at IS
  'Suporte a filtros do dashboard admin por status e data.';
