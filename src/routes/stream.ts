import type { AppServices } from './types.js';
import { streamsNeedRevalidation } from './origin.js';
import { errorMessage } from '../utils/logger.js';
import * as frozen from '../utils/stream-frozen.js';

type StreamArgs = { type: string; id: string };

function createStreamHandler(services: AppServices) {
  return async (args: StreamArgs) => {
    const ctx = services.runtime.capture();
    // Shadow: uma captura POR REQUEST em `<base>/<shadowId>`; o dir devolvido
    // entra no AsyncLocalStorage para os hooks da busca inteira o enxergarem.
    const frozenDir = frozen.beginRequest({
      type: args.type,
      id: args.id,
      encoded: ctx?.encoded ?? null,
      deadlineMs: services.runtime.replyDeadline(),
      shadowId: ctx?.shadowId ?? null,
    });
    const handle = async () => {
      let response: { streams: any[]; cacheMaxAge?: number; staleRevalidate?: number; staleError?: number };
      try {
        const result = await services.providers.findStreams({ type: args.type, id: args.id });
        if (args.type === 'series' && typeof args.id === 'string') {
          const parts = args.id.split(':');
          if (parts.length >= 3) {
            const imdbId = parts[0];
            const s = parseInt(parts[1], 10);
            const e = parseInt(parts[2], 10);
            if (Number.isFinite(s) && Number.isFinite(e)) {
              const nextId = `${imdbId}:${s}:${e + 1}`;
              const adapter = services.debrid.current();
              const { autoFetchBr, debridApiKey } = services.runtime.opts();
              // Record/replay desligam o prefetch (ele contaminaria o corpus);
              // no shadow o comportamento é o de produção.
              if (
                !frozen.behaviorFrozen() &&
                services.config.debrid.prefetchNextEp &&
                autoFetchBr &&
                adapter &&
                (adapter.cacheCheck || adapter.autofetchSource)
              ) {
                const account = services.accountScope(debridApiKey);
                const pfKey = services.autofetch.prefetchKey(account, imdbId, s, e + 1);
                if (!services.cache.get(pfKey) && !services.prefetchInFlight.has(nextId)) {
                  services.cache.set(pfKey, 1, services.config.debrid.prefetchTtl);
                  services.prefetchInFlight.add(nextId);
                  const capturedCtx = services.runtime.capture();
                  // O prefetch é OUTRA busca: tirar o dir evita que ele grave
                  // entradas no corpus desta requisição.
                  const prefetchCtx = capturedCtx ? { ...capturedCtx, frozenDir: undefined } : capturedCtx;
                  Promise.resolve(
                    services.runtime.run(prefetchCtx, () =>
                      services.providers.findStreams({ type: 'series', id: nextId, background: true }),
                    ),
                  )
                    .catch((err: unknown) => services.log.warn('[prefetch] falha em background:', errorMessage(err)))
                    .finally(() => services.prefetchInFlight.delete(nextId));
                }
              }
            }
          }
        }

        const streams = services.providers.applyNoticeOrigin(result.streams);
        if (services.providers.onlyNotice(result.streams) || streamsNeedRevalidation(result)) {
          response = { streams, cacheMaxAge: 0 };
        } else {
          response = {
            streams,
            cacheMaxAge: services.config.cacheTtl,
            staleRevalidate: services.config.cacheTtl * 4,
            staleError: 86400,
          };
        }
      } catch (err) {
        services.log.error('[stream]', err);
        response = { streams: [], cacheMaxAge: 0 };
      }
      frozen.finishResponse(response, { origin: ctx?.origin ?? null, encoded: ctx?.encoded ?? null });
      return response;
    };
    return frozenDir ? services.runtime.run({ frozenDir }, handle) : handle();
  };
}

export { createStreamHandler };
