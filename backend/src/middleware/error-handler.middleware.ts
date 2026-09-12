import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/app-error.js';
import { logger } from '../utils/logger.js';
import { redactSensitiveData } from '../utils/redact-sensitive-data.js';

export const errorHandlerMiddleware: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    const flat = err.flatten();
    const fieldErrors = flat.fieldErrors as Record<string, string[] | undefined>;
    const fieldMessages = Object.entries(fieldErrors).flatMap(([path, msgs]) =>
      (msgs ?? []).map((m: string) => `${path}: ${m}`),
    );
    const formMessages = (flat.formErrors ?? []) as string[];
    const firstDetail = [...formMessages, ...fieldMessages][0];
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: firstDetail ? `Dados inválidos — ${firstDetail}` : 'Dados inválidos',
        details: flat,
        requestId: req.requestId,
      },
    });
    return;
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error(err.message, {
        code: err.code,
        requestId: req.requestId,
        details: redactSensitiveData(err.details),
      });
    }

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        requestId: req.requestId,
      },
    });
    return;
  }

  const message = err instanceof Error ? err.message : 'Erro interno';
  logger.error('Unhandled error', {
    message,
    requestId: req.requestId,
    stack: err instanceof Error ? err.stack : undefined,
  });

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Erro interno do servidor',
      requestId: req.requestId,
    },
  });
};
