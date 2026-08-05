import type { RequestHandler } from 'express';

export const notFoundMiddleware: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Rota não encontrada: ${req.method} ${req.path}`,
      requestId: req.requestId,
    },
  });
};
