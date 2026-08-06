import rateLimit from 'express-rate-limit';

const skipInTest = () => process.env.NODE_ENV === 'test';

export const globalRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: {
    error: {
      code: 'RATE_LIMIT',
      message: 'Muitas requisições. Tente novamente em breve.',
    },
  },
});

export const paymentRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: {
    error: {
      code: 'RATE_LIMIT',
      message: 'Limite de criação de pagamentos excedido.',
    },
  },
});

export const webhookRateLimit = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

export const adminRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: {
    error: {
      code: 'RATE_LIMIT',
      message: 'Limite de requisições administrativas excedido.',
    },
  },
});

export const publicRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: {
    error: {
      code: 'RATE_LIMIT',
      message: 'Limite de requisições públicas excedido.',
    },
  },
});

export const publicWriteRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: {
    error: {
      code: 'RATE_LIMIT',
      message: 'Limite de criação/reemissão pública excedido.',
    },
  },
});
