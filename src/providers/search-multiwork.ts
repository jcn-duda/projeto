import config from '../config.js';
import debrid from '../debrid/index.js';
import * as tmdb from '../utils/tmdb.js';
import { getHomeReleaseAt } from '../utils/tmdb-home-release.js';
import type { MultiWorkCollection } from '../../types/domain.js';

/**
 * Suporte nativo a packs multiobra BR (BR_MULTIWORK_PACKS, default true; `false`
 * é o kill-switch), extraído do
 * `search-orchestrator` para não estourar o teto de linhas. Duas metades:
 *
 * - `startMultiWorkDiscovery` dispara a leitura do `belongs_to_collection` do
 *   TMDB EM PARALELO com os metadados (não soma parede de tempo) e só sai com
 *   as precondições de operador/estado: flag ligada, filme, debrid ativo. O
 *   deadline é o ABSOLUTO da requisição, capeado por
 *   `TMDB_COLLECTION_TIMEOUT_MS` (`min(deadlineAt, now+cap)`) — cap, nunca
 *   soma — e a coleta depois consome o que sobrou (`remainingCheckBudget`).
 * - `resolveMultiWork` fecha o contexto exigindo ANO conhecido — sem ele a dica
 *   assinada (`w`) não seleciona arquivo dentro da coleção e não há cobertura
 *   a exigir.
 *
 * Fail-open em tudo: sem flag, sem debrid, sem coleção ou sem ano, devolve
 * null/`{collection:null}` e a busca segue exatamente como antes.
 */
export interface MultiWorkPlan {
  collection: MultiWorkCollection | null;
  query: string | null;
}

function startMultiWorkDiscovery({
  imdbId,
  season,
  isDemo,
  deadlineAt,
}: {
  imdbId: string;
  season: number | null;
  isDemo: boolean;
  deadlineAt: number;
}): Promise<MultiWorkCollection | null> {
  const enabled = config.search.multiWorkPacks && season == null && !isDemo && Boolean(debrid.current());
  if (!enabled) return Promise.resolve(null);
  return tmdb.getCollection(imdbId, Math.min(deadlineAt, Date.now() + config.tmdb.collectionTimeout));
}

/**
 * 1º lançamento doméstico do filme no TMDB (`tmdb-home-release.ts`), em
 * paralelo com a coleção e sob o mesmo teto curto. Série e demo não pedem;
 * falha devolve null e nada é cortado.
 */
function startHomeReleaseLookup({ imdbId, season, isDemo, deadlineAt }: {
  imdbId: string; season: number | null; isDemo: boolean; deadlineAt: number;
}): Promise<number | null> {
  if (season != null || isDemo || !config.search.preHomeReleaseCut) return Promise.resolve(null);
  return getHomeReleaseAt(imdbId, Math.min(deadlineAt, Date.now() + config.tmdb.collectionTimeout)).catch(() => null);
}

function resolveMultiWork(collection: MultiWorkCollection | null, year: number | string | null): MultiWorkPlan {
  const catalogYear = Number(String(year ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  if (!collection || !catalogYear) return { collection: null, query: null };
  return { collection, query: collection.root };
}

export { startMultiWorkDiscovery, resolveMultiWork, startHomeReleaseLookup };
