// Promoção tardia do cache de busca. Extraído de `search-orchestrator.ts` pela
// catraca de 400 linhas. Se as fontes lentas trouxeram algo, reconstrói tudo; se
// não, só promove a entrada a completa — sem refazer a checagem no debrid.
//
// A DECISÃO (promover × invalidar × não mexer, TTL e o motivo) mora em
// `search-commit.ts::latePromotionDecision` — é ela que o golden mede contra o
// TS e que o núcleo Rust porta (`adom-core::search_finish`). Aqui ficam só os
// efeitos no cache e o portão que precisa rodar ANTES de ler o cache: `get()`
// apaga entrada expirada, e consultá-lo num caso em que o TS antigo não
// consultava mudaria o comportamento.
import config from '../config.js';
import * as cache from '../utils/cache.js';
import * as log from '../utils/logger.js';
import type { SerializedStreamTrace } from '../utils/stream-trace.js';
import { latePromotionDecision } from './search-commit.js';
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
    const decision = latePromotionDecision({
      hitPartial: Boolean(hit?.partial),
      hitFallback: Boolean((hit as { fallback?: unknown } | null)?.fallback),
      hitHasStreams: Boolean(hit?.streams?.length),
      hitDebridKnown: (hit as { debridKnown?: unknown } | null)?.debridKnown === true,
      live,
      cacheTtl: config.cacheTtl,
    });
    if (decision.action === 'none') {
      if (decision.reason === 'sem_resposta_dos_indexers') {
        // Lista VAZIA com indexer falho não é "sem resultado", é "sem resposta":
        // promovê-la grava o vazio como completo por CACHE_TTL. Medido com o
        // Jackett parado (Slugs, tt0093995, 2026-09-18): 15 min de "nenhum
        // stream" depois que ele voltou. Fica parcial e a próxima abertura tenta.
        log.info(`[search] coleta sem resposta dos indexers; lista vazia segue parcial para ${id}`);
      }
      return undefined;
    }
    if (decision.action === 'forget') {
      // Reserva do banco (Etapa 4): se a falha que a justificava JÁ sumiu
      // (indexer respondeu com item relevante), a entrada não vale mais o TTL
      // curto — invalida para a próxima abertura reconstruir do vivo. Com a
      // falha viva, ou com o indexer ainda respondendo vazio suspeito, mantém.
      cache.forget(cacheKey);
      log.info(`[search] reserva do banco invalidada (indexer respondeu); ${id}`);
      return undefined;
    }
    // Promover NÃO refaz a checagem de cache, então `debridKnown` é copiado
    // como está: promessa de completude da COLETA não é promessa de ⚡.
    // P5 — `hit.trace` copiado OBRIGATORIAMENTE: a promoção substitui a entrada
    // inteira, e sem o campo o ledger da primeira build seria apagado.
    cache.set(cacheKey, {
      streams: hit.streams,
      partial: false,
      debridKnown: decision.debridKnown,
      trace: (hit as { trace?: SerializedStreamTrace | null }).trace ?? null,
      searchMeta: (hit as { searchMeta?: unknown }).searchMeta ?? null,
    }, decision.ttl);
    log.info(`[search] coleta encerrada sem novidade; ${hit.streams.length} stream(s) para ${id}`);
    return undefined;
  };
}
