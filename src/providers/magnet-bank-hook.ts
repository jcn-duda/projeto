// Ponte pipeline → banco de magnets vivo.
//
// O `prepareCandidateStreams` tem `antesTitulo` (o que ENTROU no filtro) e
// `raw` (o que SOBREVIVEU), mas o banco só precisa dos hashes — item de CONTA
// (`fromAccount`) fica de fora: o inventário não é acervo do site e não deve
// virar `magnet_work`. A extração de hash vive aqui para o pipeline não ganhar
// linhas (ele opera no teto de 400).
import type { RawItem } from '../../types/domain.js';
import { hashOf, markFilterResult } from '../utils/magnet-bank.js';
import type { WorkCtx } from '../utils/magnet-bank.js';

/** Hashes únicos (não-conta) de uma lista de itens, na ordem. */
function hashesOf(items: readonly RawItem[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || item.fromAccount) continue;
    const hash = hashOf(item);
    if (hash && !seen.has(hash)) {
      seen.add(hash);
      out.push(hash);
    }
  }
  return out;
}

/**
 * Escreve o resultado do filtro de título na obra: 1 para os sobreviventes, 0
 * para os demais que a captura registrou. Fonte que o Jackett não capturou não
 * tem work e é ignorada pelo banco (sem órfão).
 */
export function markBankFilterOutcome(entered: readonly RawItem[], survivors: readonly RawItem[], ctx: WorkCtx): void {
  const all = hashesOf(entered);
  if (all.length === 0) return;
  markFilterResult(all, hashesOf(survivors), ctx);
}
