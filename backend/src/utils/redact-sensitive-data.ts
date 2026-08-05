const SENSITIVE_KEYS = new Set([
  'client_secret',
  'clientsecret',
  'access_token',
  'accesstoken',
  'authorization',
  'password',
  'private_key',
  'privatekey',
  'service_role_key',
  'servicerolekey',
  'supabase_service_role_key',
  'internal_api_key',
  'cpf',
  'chave',
  'pix_key',
  'pixkey',
  'cert',
  'key',
  'ca',
]);

function maskValue(key: string, value: string): string {
  const lower = key.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (lower.includes('cpf') && value.length >= 11) {
    return `***${value.slice(-2)}`;
  }

  if (
    lower.includes('pixkey') ||
    lower === 'chave' ||
    lower.includes('token') ||
    lower.includes('secret') ||
    lower.includes('password') ||
    lower.includes('authorization') ||
    lower.includes('service')
  ) {
    if (value.length <= 8) return '****';
    return `${value.slice(0, 4)}…${value.slice(-2)}`;
  }

  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}…${value.slice(-2)}`;
}

export function redactSensitiveData(input: unknown): unknown {
  if (input === null || input === undefined) return input;

  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveData(item));
  }

  if (typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (SENSITIVE_KEYS.has(normalized) || SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] =
          typeof value === 'string' ? maskValue(key, value) : '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        result[key] = redactSensitiveData(value);
      } else if (typeof value === 'string' && value.length > 200 && /BEGIN .+ PRIVATE KEY/.test(value)) {
        result[key] = '[REDACTED_PRIVATE_KEY]';
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return input;
}

export function maskCpf(cpf: string): string {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-2)}`;
}

export function maskPixKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-2)}`;
}

export function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…****`;
}
