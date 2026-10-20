// Carga dos metadados da busca: Cinemeta/TMDB + multiobra + 1º lançamento
// doméstico. Extraído do orquestrador para a catraca de linhas (400).
//
// Em produção as quatro consultas correm em paralelo; no replay congelado as
// quatro entradas vêm do arquivo (`frozen.aroundMeta`) e a espera entra na
// medição de `search.metadata` de propósito.
import { getMeta } from '../utils/cinemeta.js';
import * as tmdb from '../utils/tmdb.js';
import * as frozen from '../utils/stream-frozen.js';
import { startMultiWorkDiscovery, startHomeReleaseLookup } from './tmdb-multiwork.js';
import type { MultiWorkCollection } from '../../types/domain.js';

export interface SearchMetadata {
  meta: any;
  titles: any;
  collection: MultiWorkCollection | null;
  homeReleaseAt: number | null;
}

export async function loadSearchMetadata({
  type,
  id,
  imdbId,
  season,
  isDemo,
  deadlineAt,
}: {
  type: string;
  id: string;
  imdbId: string;
  season: number | null;
  isDemo: boolean;
  deadlineAt: number;
}): Promise<SearchMetadata> {
  if (frozen.active()) {
    const captured = await frozen.aroundMeta(`${type}:${id}`, async () => {
      const [meta, titles, collection, homeReleaseAt] = await Promise.all([
        getMeta(type, imdbId),
        tmdb.getTitles(imdbId),
        startMultiWorkDiscovery({ imdbId, season, isDemo, deadlineAt }),
        startHomeReleaseLookup({ imdbId, season, isDemo, deadlineAt }),
      ]);
      return { meta, titles, collection, homeReleaseAt };
    });
    return {
      meta: captured.meta,
      titles: captured.titles,
      collection: captured.collection as MultiWorkCollection | null,
      homeReleaseAt: captured.homeReleaseAt,
    };
  }

  const collectionPromise = startMultiWorkDiscovery({ imdbId, season, isDemo, deadlineAt });
  const homeReleasePromise = startHomeReleaseLookup({ imdbId, season, isDemo, deadlineAt });
  const [meta, titles] = await Promise.all([getMeta(type, imdbId), tmdb.getTitles(imdbId)]);
  // M3: a espera da coleção (e da data doméstica) fica FORA do timer de
  // metadados e usa o deadline absoluto já em curso.
  return {
    meta,
    titles,
    collection: await collectionPromise,
    homeReleaseAt: await homeReleasePromise,
  };
}
