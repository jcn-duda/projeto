import express from 'express';
import { parse as parseQuery } from 'node:querystring';

type AddonManifest = {
  resources: Array<string | { name: string }>;
  catalogs: unknown[];
  behaviorHints?: Record<string, unknown>;
  [key: string]: unknown;
};

type AddonResponse = {
  cacheMaxAge?: number;
  staleRevalidate?: number;
  staleError?: number;
  redirect?: string;
  [key: string]: unknown;
};

type AddonHandlerArgs = {
  type: string;
  id: string;
  extra: Record<string, string | string[] | undefined>;
  config: Record<string, never>;
};

type AddonInterface = {
  manifest: AddonManifest;
  get(resource: string, type: string, id: string, extra?: Record<string, string | string[] | undefined>, config?: Record<string, never>): Promise<AddonResponse>;
};

type StreamHandler = (args: AddonHandlerArgs) => AddonResponse | Promise<AddonResponse>;

function resourcesIn(manifest: AddonManifest) {
  return manifest.resources.map((resource) => (typeof resource === 'string' ? resource : resource.name));
}

/**
 * O SDK só entregava uma interface pequena ao router. Mantemos a forma para
 * compatibilidade de quem ainda importa o default de addon.ts, sem carregar a
 * árvore antiga de CLI/publicação do pacote.
 */
function createAddonInterface(manifest: AddonManifest, streamHandler: StreamHandler): AddonInterface {
  if (!resourcesIn(manifest).includes('stream')) {
    throw new Error('manifest.resources não contém stream');
  }
  if (JSON.stringify(manifest).length > 8192) {
    throw new Error('manifest size exceeds 8kb, which is incompatible with addonCollection API');
  }
  Object.freeze(manifest);
  return {
    manifest,
    get(resource, type, id, extra = {}, config = {}) {
      if (resource !== 'stream') {
        return Promise.reject({ message: `No handler for ${resource}`, noHandler: true });
      }
      return Promise.resolve(streamHandler({ type, id, extra, config }));
    },
  };
}

function applyCors(req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'OPTIONS') return next();
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  const requestedHeaders = req.get('Access-Control-Request-Headers');
  if (requestedHeaders) res.setHeader('Access-Control-Allow-Headers', requestedHeaders);
  return res.status(204).end();
}

function cacheControl(response: AddonResponse) {
  const mappings: Array<[keyof AddonResponse, string]> = [
    ['cacheMaxAge', 'max-age'],
    ['staleRevalidate', 'stale-while-revalidate'],
    ['staleError', 'stale-if-error'],
  ];
  const values = mappings
    .filter(([key]) => Number.isInteger(response[key]))
    .map(([key, name]) => `${name}=${response[key]}`);
  return values.length ? `${values.join(', ')}, public` : null;
}

/** Router mínimo do protocolo Stremio que o processo realmente expõe. */
function makeAddonRouter(addonInterface: AddonInterface) {
  const router = express.Router();
  router.use(applyCors);

  const manifestJson = JSON.stringify(addonInterface.manifest);
  router.get('/manifest.json', (_req, res) => {
    res.type('application/json').send(manifestJson);
  });

  router.get('/stream/:type/:id/:extra?.json', async (req, res, next) => {
    // req.params decodifica %26 e mudaria a divisão dos extras; o SDK lia o
    // último segmento cru da URL exatamente por isso.
    const extraPart = req.params.extra ? (req.url.split('/').pop() || '').slice(0, -5) : '';
    const extra: Record<string, string | string[]> = {};
    if (extraPart) {
      for (const [k, v] of Object.entries(parseQuery(extraPart))) {
        if (v !== undefined) extra[k] = v;
      }
    }
    try {
      const response = await addonInterface.get('stream', req.params.type, req.params.id, extra, {});
      const header = cacheControl(response);
      if (header) res.setHeader('Cache-Control', header);
      if (typeof response.redirect === 'string' && response.redirect) {
        return res.redirect(307, response.redirect);
      }
      return res.type('application/json').send(JSON.stringify(response));
    } catch (err: unknown) {
      if ((err as { noHandler?: boolean })?.noHandler) return next();
      return res.status(500).json({ err: 'handler error' });
    }
  });
  return router;
}

export { createAddonInterface, makeAddonRouter };
export type { AddonHandlerArgs, AddonInterface, AddonManifest, AddonResponse, StreamHandler };
