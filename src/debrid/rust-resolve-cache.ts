/**
 * Efeito de cache que o resolve em Rust já decidiu. A lista pronta
 * (`streams:vN`) mora no L1 deste processo Node; outro processo não a apaga.
 * Espelha `invalidateStreamsOnBlocked` (namespace inteiro, com cooldown) e
 * `invalidateStreamsForObra` (só a obra). Não marca magnet: isso continua
 * sendo decisão de evidência, não de cache.
 */
import config from '../config.js';
import { errorMessage } from '../utils/logger.js';
import { invalidateStreamsForObra } from '../utils/br-gap.js';

// Rajada de plays bloqueados não pode esfriar o cache de todo mundo
// repetidamente. O instante fica neste processo — é o L1 daqui que se apaga.
let lastBlockedInvalidateAt = 0;

interface CacheEffectServices {
  cache: { clearNamespace(namespace: string): number };
  metrics: { count(name: string, n?: number): void };
  log: { info(msg: string): void; warn(msg: string): void };
}

export function applyCacheEffect(
  effect: { invalidate: 'obra' | 'streams' | 'none' },
  imdbId: string,
  services: CacheEffectServices,
): number {
  if (effect.invalidate === 'none') return 0;
  if (effect.invalidate === 'obra') return invalidateStreamsForObra(imdbId);
  if (effect.invalidate === 'streams') return invalidateStreamsOnBlocked(services);
  return 0;
}

function invalidateStreamsOnBlocked(services: CacheEffectServices): number {
  const cooldown = Math.max(0, Number(config.debrid.resolveBlockedInvalidateCooldownMs) || 0);
  // 0 desliga: sem escrita e sem avançar o instante.
  if (!cooldown) return 0;
  const now = Date.now();
  if (now - lastBlockedInvalidateAt < cooldown) return 0;
  lastBlockedInvalidateAt = now;
  try {
    const removed = services.cache.clearNamespace('streams');
    if (removed) {
      services.metrics.count('resolve.streamsInvalidated.blocked');
      services.log.info(`[resolve] cache de streams invalidado por bloqueio legal (${removed} entrada(s)); a próxima abertura não oferece mais este hash pelo debrid (ledger blocked)`);
    }
    return removed;
  } catch (err) {
    services.log.warn(`[resolve] falhou ao invalidar streams após 451: ${errorMessage(err)}`);
    return 0;
  }
}
