import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCorsOptions } from './config/cors.js';
import { requestIdMiddleware } from './middleware/request-id.middleware.js';
import { globalRateLimit } from './middleware/rate-limit.middleware.js';
import { notFoundMiddleware } from './middleware/not-found.middleware.js';
import { errorHandlerMiddleware } from './middleware/error-handler.middleware.js';
import routes from './routes/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
        },
      },
    }),
  );
  app.use(cors(getCorsOptions()));
  // Assinatura data URL do waiver público pode chegar a ~500kb.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(requestIdMiddleware);
  app.use(globalRateLimit);

  // Painel admin interno. API key via header, nunca query string.
  const painelRoot = resolve(__dirname, '../painel');
  app.use(
    '/painel',
    express.static(painelRoot, {
      index: false,
      fallthrough: true,
      setHeaders(res) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Cache-Control', 'no-store');
      },
    }),
  );

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
