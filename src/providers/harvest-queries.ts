// Queries de UMA obra colhida: primária (mainstream/EN), pt-BR (fallback das
// fontes BR) e o degrau do título original. Extraído do harvestOne para o
// modo dirigido da sonda (Fase 4) reusar EXATAMENTE a mesma montagem — sem
// duplicar a regra de query, que é uma das que mais quebram em silêncio.
import { buildSearchQuery, resolveOriginalStepName } from '../utils/format.js';
import type { HarvestEntry } from './harvest-queue.js';

type SearchMeta = { name: string; year: number | string | null; names: string[] };
type Titles = { pt?: string | null; original?: string | null; year?: number | string | null } | null | undefined;

export interface WorkQueries {
  query: string;
  ptQuery: string | null;
  originalQuery: string | null;
}

export function buildWorkQueries(
  entry: Pick<HarvestEntry, 'season' | 'episode'>,
  searchMeta: SearchMeta,
  titles: Titles,
): WorkQueries {
  const location = { season: entry.season ?? null, episode: entry.episode ?? null };
  const query = buildSearchQuery(searchMeta, location);
  // Só vale uma query pt separada quando o título pt difere do original — a
  // direção da cascata (qual é primária) é decidida por quem consulta.
  const ptQuery = titles?.pt && titles.pt !== titles.original
    ? buildSearchQuery({ name: titles.pt, year: titles.year ?? null }, location)
    : null;
  const originalQuery = resolveOriginalStepName(titles?.original, searchMeta.name);
  return { query, ptQuery, originalQuery };
}
