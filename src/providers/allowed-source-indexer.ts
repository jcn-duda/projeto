// Filtro de origem compartilhada (idx / magnet-bank) pela config do pedido.
// Índice e acervo são globais entre instalações; sem isto, `p=jackett` (sem
// torrentio) recebia releases gravadas como `indexer:'torrentio'`, e `ji`
// restrito via instantânea/fallback de fontes fora da seleção.
import config from '../config.js';
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

  // Index-only (redetorrent/apachetorrent/1337x por default) nunca é consultado
  // ao vivo por instalação — só o colhedor do operador o lê, e a única porta
  // dele para a lista é o idx/banco. O `ji` não o governa: na VPS o `.env` tem
  // `apachetorrent` (id inexistente) e a /configure desmarca o
  // `apachetorrent-cardigann`, então filtrá-lo cortava a fonte para todos.
  if (config.jackett.indexOnlyIndexers.some((x) => String(x).toLowerCase() === lower)) return true;

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
