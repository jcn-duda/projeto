// Bloco `cache` do `/dashboard-status.json` — extraído de
// `dashboard-status-blocks.ts` pela catraca de 400 linhas (C4, commit 3).
//
// O bloco mantém o contrato do L1 local (`entries`/`maxEntries`/`namespaces`
// do snapshot, `persistent`, `l2` e `hits`/`misses`/`hitRate` dos contadores
// do Node) e ACRESCENTA a foto nativa do `streams.db` (`native`) quando a
// ponte de leitura responde: `{source:'gateway', entries, quota, hit,
// staleServed, miss, writes, hitRate, degraded}`. Sem a ponte (gateway velho
// ou fora), `native` fica AUSENTE — ausente é "não medido", nunca 0 inventado;
// o painel mostra '—'.
//
// Repare que o `staleServed` aqui é o SWR DE VERDADE (servido stale pelo
// gateway); o antigo `swrServed` local não tem produtor e saiu do payload.
import type { AppServices } from './types.js';
import type { MetricSnapshot } from './dashboard-status-helpers.js';
import type { NativeStreamsStats } from '../utils/streams-stats-native.js';

/** Campos numéricos do gateway que o bloco repassa (a ponte já validou como
 * finitos; a re-checagem é a guarda barata do tipo). */
const NATIVE_NUMBER_FIELDS = ['entries', 'quota', 'hit', 'staleServed', 'miss', 'writes'] as const;

function nativeSnapshot(stats: NativeStreamsStats): Record<string, unknown> {
  const out: Record<string, unknown> = { source: 'gateway' as const };
  for (const field of NATIVE_NUMBER_FIELDS) {
    const value = stats[field];
    if (typeof value === 'number') out[field] = value;
  }
  // `hitRate: null` do gateway é RESPOSTA (sem consulta no período) e viaja
  // como null; campo ausente continua ausente.
  if (stats.hitRate === null || typeof stats.hitRate === 'number') out.hitRate = stats.hitRate;
  if (typeof stats.degraded === 'boolean') out.degraded = stats.degraded;
  return out;
}

export function cacheBlock(
  services: AppServices,
  metricSnapshot: MetricSnapshot,
  nativeStats: NativeStreamsStats | null,
): Record<string, unknown> {
  const hits = metricSnapshot.counters['cache.hit'] || 0;
  const misses = metricSnapshot.counters['cache.miss'] || 0;
  const block: Record<string, unknown> = {
    ...services.cache.snapshot(),
    persistent: services.config.cache.persist,
    l2: services.cache.l2Stats(),
    hits,
    misses,
    hitRate: hits + misses > 0 ? hits / (hits + misses) : null,
  };
  // Foto nativa ADITIVA (mesmo contrato do `metrics.native`): só existe quando
  // o gateway respondeu.
  if (nativeStats) block.native = nativeSnapshot(nativeStats);
  return block;
}
