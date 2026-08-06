import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { getCorsOptions } from './config/cors.js';
import { requestIdMiddleware } from './middleware/request-id.middleware.js';
import { globalRateLimit } from './middleware/rate-limit.middleware.js';
import { notFoundMiddleware } from './middleware/not-found.middleware.js';
import { errorHandlerMiddleware } from './middleware/error-handler.middleware.js';
import routes from './routes/index.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors(getCorsOptions()));
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(requestIdMiddleware);
  app.use(globalRateLimit);

  // Health também em /health (além de /health via router)
  app.get('/health', (req, res, next) => {
    Promise.resolve(
      import('./controllers/health.controller.js').then(({ healthController }) => {
        healthController.check(req, res);
      }),
    ).catch(next);
  });

  app.get('/health/reconciliation', (req, res, next) => {
    Promise.resolve(
      import('./controllers/health.controller.js').then(({ healthController }) => {
        healthController.reconciliation(req, res);
      }),
    ).catch(next);
  });

  app.use(routes);

  app.use(notFoundMiddleware);
  app.use(errorHandlerMiddleware);

  return app;
}
