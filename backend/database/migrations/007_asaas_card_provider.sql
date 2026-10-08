-- Provedor Asaas (cartão de crédito) em payment_providers.
-- NÃO armazena API key nem token de webhook (ficam no .env da API).
-- Não altera o provedor Sicredi/PIX. Executar manualmente no Supabase.
-- Ao migrar para produção: UPDATE ... SET environment = 'production' WHERE code = 'asaas';

INSERT INTO public.payment_providers (
  name,
  code,
  description,
  environment,
  is_active,
  is_default,
  priority,
  supports_refund,
  supports_cancel,
  supports_dynamic_charge,
  supports_webhook,
  default_expiration_seconds,
  configuration
)
SELECT
  'Asaas Cartão',
  'asaas',
  'Cartão de crédito (Visa, Mastercard, Elo, Amex) via Asaas',
  'sandbox',
  true,
  false,
  50,
  true,
  true,
  true,
  true,
  3600,
  '{"integration":"asaas_v3","billingType":"CREDIT_CARD"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM public.payment_providers WHERE code = 'asaas'
);
