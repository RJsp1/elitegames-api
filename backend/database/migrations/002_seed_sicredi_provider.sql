-- Seed idempotente do provedor Sicredi em payment_providers.
-- NÃO armazena Client ID, Client Secret, chave Pix ou certificados.
-- Executar manualmente no Supabase quando apropriado.

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
VALUES (
  'Sicredi Pix',
  'sicredi',
  'API Pix Sicredi para recebimento de inscrições',
  'production',
  true,
  true,
  1,
  true,
  true,
  true,
  true,
  1800,
  '{"integration":"api_pix","version":"v3"}'::jsonb
)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  environment = EXCLUDED.environment,
  is_active = EXCLUDED.is_active,
  is_default = EXCLUDED.is_default,
  priority = EXCLUDED.priority,
  supports_refund = EXCLUDED.supports_refund,
  supports_cancel = EXCLUDED.supports_cancel,
  supports_dynamic_charge = EXCLUDED.supports_dynamic_charge,
  supports_webhook = EXCLUDED.supports_webhook,
  default_expiration_seconds = EXCLUDED.default_expiration_seconds,
  configuration = EXCLUDED.configuration,
  updated_at = NOW();
