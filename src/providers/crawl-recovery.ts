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
 * Dry-run desligou (true→false, ao vivo ou override persistido no boot): toda
 * linha do site contaminada pelo passe seco volta a `pending` do zero —
 * `simulated` E qualquer linha com progresso `"dry":1` (partial, error,
 * pending, inflight: o crash/falha preserva o progresso seco e o resume
 * pularia cards nunca gravados). O reset zera também a CONTAGEM seca de
 * releases (`releases` acumulada no dry é descoberta, não gravação): sem
 * isso, o passe ao vivo somaria seco+vivo e o painel duplicaria o total.
 * Roda DEPOIS do `requeueInflight` (ordem do `crawler.start`/`step`): inflight
 * órfã é devolvida primeiro e o match por progresso a alcança no mesmo passe.
 * Idempotente: o reset limpa o `progress`, então repetir é no-op.
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
