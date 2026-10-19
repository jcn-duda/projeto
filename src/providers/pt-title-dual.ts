/**
 * Recupera DUAL em tracker global cujo título COMEÇA com o nome pt-BR do TMDB.
 *
 * Sem acento nem marca PT (`Lanternas…DUAL`, `A.Rocha…DUAL`), `looksPtBr` falha:
 * Dual sozinho é ambíguo (EN+qualquer idioma). O contexto da obra — título pt
 * distinto do original/en — é a prova de origem BR que o acento não trouxe.
 * MULTI sozinho NÃO entra: é faixa multiidioma de cena, não dublagem BR.
 *
 * A DECISÃO mora no núcleo Rust (`rust/crates/adom-napi/src/pt_title_dual.rs`;
 * régua em `adom-core::pt_title_dual`, com os testes do TS portados). Aqui só
 * se monta o lote (`title || Title`, `isBr`, `lied`/`_lied`) e se traduz a
 * saída; métrica e trace continuam no Node, que é I/O de efeito.
 */
import type { RawItem } from '../../types/domain.js';
import { nativeCore } from '../utils/native-core.js';
import * as metrics from '../utils/metrics.js';
import { stageTrace } from '../utils/stream-trace.js';
import type { StreamTraceState } from '../utils/stream-trace.js';

type TitlesCtx = {
  original?: string | null;
  pt?: string | null;
  en?: string | null;
} | null | undefined;

/** Funções do `ptTitleDual` no `.node` (camelCase do napi-rs). */
type PtTitleDualCore = {
  ptTitleDualMarks(
    items: Array<{
      title?: string;
      titlePascal?: string;
      isBr: boolean;
      lied: boolean;
    }>,
    titles: { original?: string; pt?: string; en?: string } | null,
  ): boolean[];
};

const core = () => nativeCore<PtTitleDualCore>();

/**
 * `String(item.title || item.Title || '')` + origem/mentira. O `_lied` é campo
 * interno do TS (o Rust só tem `lied`); os dois contam como mentira provada.
 */
function toInput(item: RawItem) {
  const title = String(item.title || item.Title || '');
  return {
    title: title || undefined,
    titlePascal: undefined,
    isBr: item.isBr === true,
    lied: item.lied === true || item._lied === true,
  };
}

function toTitles(titles: TitlesCtx) {
  return {
    original: titles?.original ?? undefined,
    pt: titles?.pt ?? undefined,
    en: titles?.en ?? undefined,
  };
}

function applyPtTitleDual(
  items: RawItem[],
  { titles, trace }: { titles?: TitlesCtx; trace?: StreamTraceState | null } = {},
): RawItem[] {
  // Sem `pt` não há contexto de obra: nenhum item pode ser marcado e não vale
  // atravessar a fronteira.
  if (!titles?.pt) return items;

  const marks = core().ptTitleDualMarks(items.map(toInput), toTitles(titles));
  let marked = 0;
  const out = items.map((item, index) => {
    if (!marks[index]) return item;
    marked += 1;
    return { ...item, ptTitleDual: true };
  });
  if (marked > 0) {
    metrics.count('search.dual.ptTitle', marked);
    stageTrace(trace, 'dual.ptTitle', marked);
  }
  return out;
}

export { applyPtTitleDual };
