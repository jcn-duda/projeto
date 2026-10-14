// Deps da SELEÇÃO PURA (`crawl-site-select.ts`): contadores da fila, gate da
// sonda e teto agregado. Extraído de `crawler.ts` pela catraca de 400 linhas
// (liberou espaço para o timer own_pace do modo rust). Nada aqui é dono do
// `crawl.db`: a engine é aberta por quem precisa (motor/status) e lida só como
// foto do instante — o status não pode abrir nada.
import * as store from '../utils/crawl-store.js';
import type { CrawlEngine, SiteCounters } from '../utils/crawl-store.js';
import { probeGateOpen, readVerdict } from './crawl-probe-gate.js';
import { siteConfigOf, type CrawlerEffectiveConfig } from '../utils/crawler-live-schema.js';
import type { SelectDeps } from './crawl-site-select.js';

/** Contadores sem abrir o `crawl.db` (o status não pode abrir nada). */
const EMPTY_COUNTERS: SiteCounters = {
  total: 0,
  byStatus: { pending: 0, inflight: 0, done: 0, 'no-torrent': 0, 'no-work': 0, error: 0, simulated: 0, partial: 0 },
};

/** A engine pode expor `hasDue` (consulta exata de vencido); até lá, contadores. */
function hasDue(siteId: string, now: number): boolean {
  const engine = store.currentEngine() as (CrawlEngine & { hasDue?: (s: string, n: number) => boolean }) | null;
  if (engine && typeof engine.hasDue === 'function') return engine.hasDue(siteId, now);
  const by = engine?.counters(siteId).byStatus ?? EMPTY_COUNTERS.byStatus;
  return (by.pending || 0) + (by.error || 0) + (by.inflight || 0) + (by.partial || 0) > 0;
}

/**
 * Fábrica das deps do tick: o teto agregado (`hourPages`) é estado do motor e
 * entra por closure; o resto é leitura de foto. Sempre sobre o snapshot do
 * tick, nunca `effective()` re-lida.
 */
export function selectDepsOf(hourPages: { current(): number }) {
  return (live: CrawlerEffectiveConfig): SelectDeps => ({
    counters: (id) => store.currentEngine()?.counters(id) ?? EMPTY_COUNTERS,
    probeOpen: (id) => probeGateOpen(siteConfigOf(live, id).requireProbe, readVerdict(store.currentEngine(), id)),
    globalCapHit: () => hourPages.current() >= live.maxPerHour,
    hasDue,
  });
}
