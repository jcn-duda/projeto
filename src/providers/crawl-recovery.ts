// Recuperações one-shot do motor da raspagem (extraído de `crawler.ts` pela
// catraca de 400 linhas). São as duas passadas que rodam ANTES de processar
// qualquer página: inflight órfã (religar/start) e `simulated` de dry-run
// desligado. Ambas são idempotentes por natureza: tocam só linhas do status
// alvo, então repetir é no-op.
import * as store from '../utils/crawl-store.js';
import * as log from '../utils/logger.js';

/** Crash recovery: `inflight` volta a `pending`, mesmo com pending na fila —
 * o idle path sozinho não cobre o religar ao vivo. */
export function requeueInflight(siteId: string): number {
  const n = store.engine().requeueInflight(siteId, 0, Date.now());
  if (n > 0) log.info(`[crawl] ${n} URL(s) inflight retomada(s) ao religar`);
  return n;
}

/**
 * Dry-run desligou (true→false, ao vivo ou override persistido no boot): as
 * `simulated` daquele site voltam a `pending` para serem gravadas de verdade.
 *
 * LEGADO: versões antigas gravavam `done` em dry-run SEM gravar acervo — não
 * há evidência segura para distinguir essas `done` de gravações reais, então
 * NENHUMA recuperação automática as toca; o operador decide com "Zerar site".
 */
export function requeueSimulated(siteId: string): number {
  const n = store.engine().requeueSimulated(siteId);
  if (n > 0) log.info(`[crawl] ${n} URL(s) simulada(s) do dry-run devolvida(s) à fila para gravação`);
  return n;
}
