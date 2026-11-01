/**
 * Simula o ESCRITOR ÚNICO do agregado (`mag_meta:v1:counts`) nos testes: o
 * gateway. Reconta o acervo vivo (`summary`, com o restante REAL de cada linha)
 * e grava pelo `putCounts` da ponte — o mesmo movimento do `bump_counts` do
 * núcleo com base ausente ou ilegível
 * (`rust/crates/adom-index/src/magnet_meta.rs`, `summary_recount`).
 *
 * O Node de produção NÃO grava este agregado (o `savePersistentCounts` de
 * `magnetdb-persist.ts` é no-op de régua): a simulação mora no oráculo para os
 * testes multi-processo poderem plantar o estado persistido que, em produção,
 * só o gateway escreve.
 */
import { assertSafeTestDb } from './db-guard.js';
import { magnetState, type MagMetaTotals } from '../../src/utils/debrid-state-native.js';

assertSafeTestDb('helpers/magnetdb-gateway-sim');

/** Piso de TTL que a régua antiga do Node usava ao gravar o agregado. */
const AGGREGATE_TTL_SECONDS = 7 * 86400;

/**
 * Reconta o físico e grava o agregado como o gateway faz. Idempotente por
 * construção: o payload resultante é sempre a foto exata do acervo vivo.
 */
export function persistAggregateLikeGateway(ttlSeconds = AGGREGATE_TTL_SECONDS): void {
  const now = Date.now();
  const adapters: Record<string, MagMetaTotals> = Object.create(null);
  for (const row of magnetState().summary(now)) {
    const bucket = adapters[row.adapter]
      || (adapters[row.adapter] = { alive: 0, bad: 0, lie: 0, ttlRemainingSums: { alive: 0, bad: 0, lie: 0 } });
    bucket[row.side] += row.count;
    bucket.ttlRemainingSums[row.side] += row.ttlRemainingSum || 0;
  }
  magnetState().putCounts(adapters, ttlSeconds, now);
}
