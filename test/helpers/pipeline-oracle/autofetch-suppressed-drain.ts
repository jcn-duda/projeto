// Dreno TS da represa `sup:`. Saiu de `src/providers/autofetch-suppressed.ts`
// porque nenhum caminho de produção o chama: o dreno automático é do worker
// nativo (`suppressed_step`) e a ação do painel fala só com a admin do gateway.
// O fallback local do painel era segundo dono da represa e, no Real-Debrid,
// escrita na conta fora do `shared_gate`. Fica aqui como oráculo da régua
// (gate `removeById`, `force`, teto por passagem, backoff/givenup nativos).
import config from '../../../src/config.js';
import * as metrics from '../../../src/utils/metrics.js';
import * as log from '../../../src/utils/logger.js';
import { retrySuppressedNative } from '../../../src/utils/autofetch-state-native.js';
import { forgetSuppressed, listSuppressed } from '../../../src/providers/autofetch-suppressed.js';
import type { DebridAdapter } from '../../../types/domain.js';

/**
 * Conta uma falha de remoção e agenda a próxima tentativa. Backoff e
 * desistência são do NATIVO (`SuppressedV3::retry`): na 5ª falha ele já
 * esqueceu o registro, e o `forgetSuppressed` só tira a chave do índice de
 * processo (o `kvForget` de chave ausente é no-op).
 */
function scheduleRetry(adapterId: string, account: string, hash: string, agora: number) {
  const nativeRetry = retrySuppressedNative(adapterId, account, hash, config.debrid.suppressedTtl, agora);
  if (nativeRetry !== 'given-up') return;
  forgetSuppressed(adapterId, account, hash);
  metrics.count('autofetch.suppressed.givenup');
}

type DrainSuppressedOpts = {
  max?: number;
  force?: boolean;
};

/**
 * Drena o que ficou para trás. Sem `force` respeita o gate estático
 * (`removeById`); teto por passagem `opts.max` (default
 * `config.debrid.suppressedDrainMax`) e só os registros JÁ elegíveis. Falha de
 * remoção NÃO esquece o registro: o id ruim é aposentado pelo givenup.
 */
export async function drainSuppressed(
  adapter: DebridAdapter,
  apiKey: string,
  account: string,
  opts?: DrainSuppressedOpts,
) {
  if (!config.debrid.removeById && !opts?.force) return 0;
  if (typeof adapter.removeTorrent !== 'function') return 0;
  const max = Math.max(
    1,
    Math.trunc(opts?.max && opts.max > 0 ? opts.max : config.debrid.suppressedDrainMax),
  );
  const agora = Date.now();
  const pendentes = listSuppressed(adapter.id, account, agora);
  if (pendentes.length === 0) return 0;
  let apagados = 0;
  for (const reg of pendentes.slice(0, max)) {
    const ok = await adapter.removeTorrent(apiKey, reg.id).catch(() => false);
    if (!ok) {
      scheduleRetry(adapter.id, account, reg.hash, agora);
      continue;
    }
    forgetSuppressed(adapter.id, account, reg.hash);
    metrics.count('autofetch.suppressed.drained');
    apagados += 1;
  }
  if (apagados > 0) {
    log.info(`[autofetch] remoção por id ligada: ${apagados} transferência(s) represada(s) apagada(s)`);
  }
  return apagados;
}
