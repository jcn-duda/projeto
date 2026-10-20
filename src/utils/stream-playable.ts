/**
 * A lista tem play de verdade: pelo menos um stream com url ou infoHash. O
 * item de aviso carrega só name + externalUrl. O `complete` do finish e a
 * elegibilidade do SWR usam o MESMO teste, senão os critérios divergem e o
 * stale serviria uma lista que nunca deveria ter sido promovida a completa.
 *
 * Mora em `utils/` (e não em `search-cache.ts`) porque a via do índice também
 * pergunta "isto toca?" sem depender do pipeline de busca do Node.
 */
export function hasPlayableStream(streams: any[]) {
  return Array.isArray(streams) && streams.some((s) => s && (s.url || s.infoHash));
}
