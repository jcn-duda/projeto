// Promoção tardia do cache de busca. Extraído de `search-orchestrator.ts` pela
// catraca de 400 linhas. Se as fontes lentas trouxeram algo, reconstrói tudo; se
// não, só promove a entrada a completa — sem refazer a checagem no debrid.
import config from '../config.js';
import * as cache from '../utils/cache.js';
import * as log from '../utils/logger.js';
import type { SerializedStreamTrace } from '../utils/stream-trace.js';
import type { LiveIndexerState } from './live-indexer-state.js';

type FinishInput = { items: any[]; partial: boolean; live?: LiveIndexerState | null };
interface FinishWriter {
  (input: FinishInput, phase?: number): Promise<any>;
  phase(): number;
}

export function createLatePromoter({ finish, cacheKey, id }: { finish: FinishWriter; cacheKey: string; id: string }) {
  return (items: any[], grew: boolean, phase: any, partial = false, live: LiveIndexerState | null = null) => {
    if (grew) return finish({ items, partial, live }, phase);
    if (partial) return undefined;
    // Fase diferente = o fallback de pack assumiu; promover o lote antigo aqui
    // marcaria como pronta uma busca que ainda está em andamento.
    if (phase !== finish.phase()) return undefined;
    const hit = cache.get(cacheKey);
    if (!hit?.partial) return undefined;
    // Reserva do banco (Etapa 4): se a falha que a justificava JÁ sumiu (indexer
    // respondeu com item relevante), a entrada não vale mais o TTL curto —
    // invalida para a próxima abertura reconstruir do vivo. Com a falha viva,
    // ou com o indexer ainda respondendo vazio suspeito, mantém a reserva.
    if ((hit as { fallback?: boolean }).fallback) {
      if (live && !live.needsFallback()) {
        cache.forget(cacheKey);
        log.info(`[search] reserva do banco invalidada (indexer respondeu); ${id}`);
      }
      return undefined;
    }
    // Lista VAZIA com indexer falho não é "sem resultado", é "sem resposta":
    // promovê-la gravava o vazio como completo por CACHE_TTL. Medido com o
    // Jackett parado (Slugs, tt0093995, 2026-09-18): 15 min de "nenhum stream"
    // depois que ele voltou. Fica parcial (TTL curto) e a próxima abertura tenta.
    if (!hit.streams?.length && live?.hasAnyFailure()) {
      log.info(`[search] coleta sem resposta dos indexers; lista vazia segue parcial para ${id}`);
      return undefined;
    }
    // Promover NÃO refaz a checagem de cache, então `debridKnown` é copiado
    // como está: promessa de completude da COLETA não é promessa de ⚡.
    // P5 — `hit.trace` copiado OBRIGATORIAMENTE: a promoção substitui a entrada
    // inteira, e sem o campo o ledger da primeira build seria apagado.
    const debridKnown = hit.debridKnown === true;
    cache.set(
      cacheKey,
      { streams: hit.streams, partial: false, debridKnown, trace: (hit as { trace?: SerializedStreamTrace | null }).trace ?? null, searchMeta: (hit as { searchMeta?: unknown }).searchMeta ?? null },
      debridKnown ? config.cacheTtl : Math.min(config.cacheTtl, 60),
    );
    log.info(`[search] coleta encerrada sem novidade; ${hit.streams.length} stream(s) para ${id}`);
    return undefined;
  };
}
