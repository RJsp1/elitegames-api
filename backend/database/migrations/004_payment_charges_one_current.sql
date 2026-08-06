-- ELITE GAMES API — unique is_current por payment
-- PostgreSQL / Supabase — NÃO executar automaticamente.
--
-- Objetivo:
--   Garantir no máximo uma payment_charge com is_current = true por payment_id.
--
-- Pré-requisito (rodar ANTES do índice e corrigir se houver linhas):
--
--   SELECT payment_id, COUNT(*) AS cnt
--   FROM public.payment_charges
--   WHERE is_current = true
--   GROUP BY payment_id
--   HAVING COUNT(*) > 1;
--
-- Se existirem duplicatas, manter a charge mais recente e desmarcar as demais, ex.:
--
--   WITH ranked AS (
--     SELECT id,
--            ROW_NUMBER() OVER (
--              PARTITION BY payment_id
--              ORDER BY created_at DESC, id DESC
--            ) AS rn
--     FROM public.payment_charges
--     WHERE is_current = true
--   )
--   UPDATE public.payment_charges pc
--   SET is_current = false, updated_at = NOW()
--   FROM ranked r
--   WHERE pc.id = r.id AND r.rn > 1;
--
-- Depois aplicar o índice:

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_charges_one_current_per_payment
  ON public.payment_charges (payment_id)
  WHERE is_current = true;

COMMENT ON INDEX public.uq_payment_charges_one_current_per_payment IS
  'Garante no máximo uma charge current (is_current=true) por payment.';
