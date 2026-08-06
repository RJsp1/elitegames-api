-- ELITE GAMES API — idempotência opcional para audit_logs
-- PostgreSQL / Supabase — NÃO executar automaticamente em produção.
--
-- Objetivo:
--   Evitar duplicação de eventos financeiros únicos (PAYMENT_RECONCILED,
--   PAYMENT_AMOUNT_MISMATCH, PIX_CHARGE_CANCELLED, PIX_CHARGE_EXPIRED)
--   quando a aplicação já grava reason no formato:
--     {origin}|idemp:{chave}
--
-- Estratégia:
--   Índice único parcial em (action, entity_id, reason) apenas quando reason
--   contém o marcador idemp:. A aplicação também faz consulta prévia
--   (existsFinancialEvent) e trata 23505 como duplicata.

CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_logs_financial_idempotency
  ON public.audit_logs (action, entity_id, reason)
  WHERE reason IS NOT NULL
    AND reason LIKE '%idemp:%'
    AND entity_id IS NOT NULL;

COMMENT ON INDEX public.uq_audit_logs_financial_idempotency IS
  'Garante idempotência de eventos financeiros auditados (reason com idemp:).';
