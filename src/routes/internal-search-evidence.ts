// Evidência que só o Node tem, anexada aos itens que as rotas internas devolvem
// (`collect`/`index`): a prova de ARQUIVO do índice (`applyFileEvidence`).
//
// O `ptTitleDual` NÃO é calculado aqui. A decisão mora no núcleo do orquestrador
// Rust: os títulos da obra chegam em `/internal/search/meta`
// (`SearchMeta.titles`) → `BuildContext.titles` → `apply_pt_title_dual`, que
// marca o lote in-process antes do build. Recalcular na rota duplicava a régua e
// prendia a resposta a `getTitles` sem ganho — o Node não precisa mandar o flag.
import type { RawItem } from '../../types/domain.js';
import { applyFileEvidence } from '../providers/stream-file-evidence.js';

/**
 * Anexa a prova de arquivo do índice. Síncrono e sem rede: a rota devolve o
 * lote imediatamente; a decisão de chip/`_dubbed`/origem BR fica no Rust.
 */
export function enrichForRust(items: RawItem[]): RawItem[] {
  return applyFileEvidence(items);
}
