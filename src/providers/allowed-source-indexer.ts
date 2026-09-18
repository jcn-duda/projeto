// Filtro de origem compartilhada (idx / magnet-bank) pela config do pedido.
// Índice e acervo são globais entre instalações; sem isto, `p=jackett` (sem
// torrentio) recebia releases gravadas como `indexer:'torrentio'`, e `ji`
// restrito via instantânea/fallback de fontes fora da seleção.
import { opts } from '../runtime.js';
import { SAFE_INDEXER_ID } from './stream-builder-pipeline.js';

/** Origens que não são indexer Jackett — não entram no filtro `ji`. */
const NON_INDEXER = new Set(['autofetch', 'bludv', 'account']);

/**
 * A release/fonte com este `indexer` pode entrar na resposta desta instalação?
 * Lê `opts()` do pedido (mesma noção de `wants` do collect-orchestrator).
 */
export function allowedSourceIndexer(indexer: string): boolean {
  const id = String(indexer || '').trim();
  if (!id) return true;
  const lower = id.toLowerCase();
  if (NON_INDEXER.has(lower)) return true;

  const { providers, jackettIndexers } = opts();
  const mode = providers.includes('both') ? 'both' : (providers[0] || '');
  const wants = (name: string) => mode === 'both' || providers.includes(name);

  if (lower === 'torrentio') return wants('torrentio');

  if (SAFE_INDEXER_ID.test(id)) {
    const selected = [...new Set(
      (jackettIndexers || [])
        .filter((x: unknown) => SAFE_INDEXER_ID.test(String(x)))
        .map((x: unknown) => String(x).toLowerCase()),
    )];
    if (selected.length === 0) return true;
    return selected.includes(lower);
  }

  return true;
}
