/**
 * Efeito de cache que o resolve em Rust já decidiu. A lista pronta
 * (`streams:vN`) é do `streams.db` do gateway (F4.4a): este processo não tem
 * mais cópia no L1, então toda invalidação é PEDIDO pela ponte administrativa.
 * Espelha `invalidateStreamsOnBlocked` (namespace inteiro, com cooldown) e
 * `invalidateStreamsForObra` (só a obra). Não marca magnet: isso continua
 * sendo decisão de evidência, não de cache.
 */
import config from '../config.js';
import { errorMessage } from '../utils/logger.js';
import { invalidateStreamsForObra } from '../utils/br-gap.js';
import { clearNativeStreamsSoon } from '../utils/streams-store-native.js';

// Rajada de plays bloqueados não pode esfriar o cache de todo mundo
// repetidamente. O instante fica neste processo — é o cooldown do pedido.
let lastBlockedInvalidateAt = 0;

interface CacheEffectServices {
  metrics: { count(name: string, n?: number): void };
  log: { info(msg: string): void; warn(msg: string): void };
}

export function applyCacheEffect(
  effect: { invalidate: 'obra' | 'streams' | 'none' },
  imdbId: string,
  services: CacheEffectServices,
): number {
  if (effect.invalidate === 'none') return 0;
  if (effect.invalidate === 'obra') {
    // Sem contagem local: o L1 do Node não guarda `streams` desde o F4.4a.
    // O pedido à ponte é o efeito inteiro, e o retorno 0 mantém honesto o
    // `cleared > 0` de quem chama (nada foi removido daqui).
    const requested = invalidateStreamsForObra(imdbId);
    services.metrics.count(
      requested ? 'resolve.streamsInvalidated.obra.requested' : 'resolve.streamsInvalidated.obra.skipped',
    );
    if (requested) {
      services.log.info(`[resolve] invalidação da lista pronta de ${imdbId} solicitada ao streams.db nativo`);
    }
    return 0;
  }
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
    // F4.4a — a lista pronta vive só no `streams.db` do gateway: o L1 do Node
    // não guarda `streams` (ninguém escreve o namespace aqui), então NÃO há
    // `cache.clearNamespace` a chamar — o efeito INTEIRO é o pedido à ponte.
    // Best-effort: o play é síncrono e a ponte tem timeout curto.
    clearNativeStreamsSoon();
    services.metrics.count('resolve.streamsInvalidated.blocked');
    services.log.info(
      `[resolve] clear do streams.db solicitado por bloqueio legal; ` +
      `a próxima abertura não oferece mais este hash pelo debrid (ledger blocked)`,
    );
    return 0;
  } catch (err) {
    services.log.warn(`[resolve] falhou ao invalidar streams após 451: ${errorMessage(err)}`);
    return 0;
  }
}
