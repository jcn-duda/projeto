// Fontes que o orquestrador Rust já coleta nativamente (`SOURCES_RUST`) e que o
// Node, por isso, não deve repetir no `/internal/search/collect`. Extraído de
// `internal-search.ts` pela catraca de linhas. Lista fechada: token desconhecido
// é erro de integração, não ignorado em silêncio.

/** Fontes que o Node sabe pular no collect (as que o Rust migrou). */
export const COLLECT_SKIPPABLE_SOURCES = ['jackett', 'prowlarr', 'torrentio', 'bludv', 'mico', 'account'] as const;

/** `undefined` = ausente (nada a pular). `null` = inválido. */
export function parseSkipSources(raw: unknown): Set<string> | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((s) => (COLLECT_SKIPPABLE_SOURCES as readonly unknown[]).includes(s))) return null;
  return new Set<string>(raw as string[]);
}
