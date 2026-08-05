import type { CorsOptions } from 'cors';
import { getEnv } from './env.js';

export function getCorsOptions(): CorsOptions {
  const env = getEnv();
  const allowed = new Set(
    [env.FRONTEND_URL, env.APP_BASE_URL]
      .filter(Boolean)
      .map((u) => u.replace(/\/$/, '')),
  );

  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      const normalized = origin.replace(/\/$/, '');
      if (allowed.has(normalized) || env.NODE_ENV !== 'production') {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin não permitida: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-API-Key'],
  };
}
