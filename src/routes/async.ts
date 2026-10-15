import type express from 'express';
import * as log from '../utils/logger.js';

/** Express 4 não encaminha rejeição de handler async para o middleware de erro. */
function asyncRoute(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      log.error('[app] erro assíncrono não tratado:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
  };
}

export { asyncRoute };
