/**
 * Cobertura de busca e identidade de franquia — decisão INTEIRA no núcleo Rust
 * (`adom-core::release_name_matching` e `adom-core::franchise`, com golden
 * contra o TS do `esm`). O corpo TS saiu do branch: aqui só se monta a entrada
 * (`tokens` opcional = título já normalizado pelo chamador em lote).
 *
 * Módulo-folha: chama `nativeCore` direto, como `title-normalization.ts`.
 *
 * Regra de ouro: chamada direta SEM lote — a medição de G5 (`tmp/g5-measure.mjs`)
 * mostra o laço por item de `jackett-query-indexer`/`stream-builder-pipeline`
 * abaixo do piso de 0,5 ms.
 */
import { nativeCore } from './native-core.js';

/** Funções de cobertura/franquia no `.node` (camelCase do napi-rs). */
type NameMatchingCore = {
  matchesName(title: string, name: string, tokens: string[] | null): boolean;
  nameCoverageTokensNapi(name: string): string[];
  isMultiWorkCollectionNapi(title: string): boolean;
  franchiseRootNapi(title: string): string;
  endsWithSequenceMarkerNapi(title: string): boolean;
  containsTokenRunNapi(title: string, normalizedRoot: string): boolean;
};

const core = () => nativeCore<NameMatchingCore>();

/**
 * Base de comparação da COBERTURA: o conjunto de tokens do nome procurado que
 * `matchesName` mede. A identidade de nome curto (`shortNameIdentity`) usa a
 * MESMA base — duas cópias desse cálculo divergiriam em silêncio.
 */
function nameCoverageTokens(name: string): string[] {
  return core().nameCoverageTokensNapi(String(name));
}

/**
 * Descarta resultados que claramente não são o título procurado — indexers
 * costumam devolver "parecidos" para queries curtas. `tokens` opcionais:
 * quem chama em lote já normalizou o título e não paga de novo.
 */
function matchesName(title: string, name: string, tokens: string[] | null = null): boolean {
  return core().matchesName(String(title), String(name), tokens);
}

/**
 * Título de coleção com mais de uma obra (pack de filmes). Exige os dois
 * sinais juntos quando a palavra de empacotamento é fraca: palavra E faixa de
 * anos (`is_multi_work_collection`).
 */
function isMultiWorkCollection(title = ''): boolean {
  return core().isMultiWorkCollectionNapi(String(title));
}

/**
 * Raiz da franquia de um título: corta o subtítulo e o marcador de sequência
 * no fim, sempre exigindo 2+ palavras no resultado. Alimenta a varredura pt-BR
 * (search-plan) e a exceção de franquia do inventário da conta.
 */
function franchiseRoot(title: string): string {
  return core().franchiseRootNapi(String(title));
}

/**
 * O título termina em marcador de sequência ("Parte II", "2", "III")? É o
 * MESMO corte que o `franchiseRoot` aplica no fim.
 */
function endsWithSequenceMarker(title: string): boolean {
  return core().endsWithSequenceMarkerNapi(String(title));
}

/** O título contém a raiz como sequência contígua de palavras normalizadas. */
function containsTokenRun(title: string, normalizedRoot: string): boolean {
  return core().containsTokenRunNapi(String(title), String(normalizedRoot));
}

export {
  matchesName,
  nameCoverageTokens,
  isMultiWorkCollection,
  franchiseRoot,
  endsWithSequenceMarker,
  containsTokenRun,
};
