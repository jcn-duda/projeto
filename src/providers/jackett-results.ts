import { decodeEntities, looksPtBr } from '../utils/format.js';

/**
 * Indexers que devolvem ZERO quando a consulta leva `Category[]`.
 *
 * O TPB some com query de mais de uma palavra sem ano assim que a categoria
 * entra na URL — "Star Trek Beyond" com `Category[]=2000` dá 0, sem categoria
 * dá 100, e a mesma query com o ano ("Beyond Re-Animator 2003") dá 19 dos dois
 * jeitos. Quem paga é a varredura pt-BR e o bare title, que saem sem ano de
 * propósito: o maior tracker global voltava vazio em silêncio. Aqui a consulta
 * sai sem categoria e o filtro roda no `mapResults`, sobre o campo `Category`
 * que o Jackett já devolve. Nenhum outro indexer da lista tem esse
 * comportamento (therarbg, yts, kickass e torrentgalaxyclone respondem igual
 * com e sem categoria) — a isenção é nominal de propósito.
 */
export const CATEGORY_UNFILTERED_INDEXERS = new Set(['thepiratebay']);

/**
 * Balde Torznab do tipo: 2000–2999 = filme, 5000–5999 = TV. O `Category` do
 * Jackett traz o id fino (2040 = Movies/HD) junto de ids de tracker fora da
 * faixa Torznab (100207), então o teste é por faixa. Resultado sem categoria
 * nenhuma passa: perder release por metadado ausente é pior que deixar entrar
 * um fora de tipo, que o matchContext ainda descarta depois.
 */
export function inCategoryBucket(categories: any, bucket: number) {
  if (!Array.isArray(categories) || categories.length === 0) return true;
  return categories.some((id: any) => Number(id) >= bucket && Number(id) < bucket + 1000);
}

export function mapResults(
  data: any,
  { isBr = false, indexer = '', categoryBucket = 0 }:
    { isBr?: boolean; indexer?: string; categoryBucket?: number } = {},
) {
  const all = Array.isArray(data?.Results) ? data.Results : Array.isArray(data) ? data : [];
  const results = categoryBucket
    ? all.filter((r: any) => inCategoryBucket(r?.Category, categoryBucket))
    : all;
  return results.map((r: any) => {
    // Decodifica na ENTRADA, não só na exibição: matchesEpisode,
    // parseTitleSeasonEpisode e o índice leem este título, e a entidade crua
    // apagava a temporada do pack — "4&ordf; Temporada" virava pack sem
    // temporada declarada, que casa QUALQUER episódio.
    const title = decodeEntities(String(r.Title || ''));
    return {
      title,
      magnet: r.MagnetUri || r.Guid,
      infoHash: r.InfoHash,
      seeders: r.Seeders,
      size: r.Size,
      tracker: r.Tracker || r.TrackerId,
      // O ID estável vem do plano da consulta. Labels do Jackett variam e não
      // podem ser usados para casar a prioridade salva na URL.
      indexer: indexer || r.TrackerId || r.Tracker || '',
      downloadUrl: r.Link,
      // Flag do indexer OU do título: tracker global também hospeda dublado
      // titulado em português, e é o título que denuncia. Decidir só pelo
      // indexer fazia esse resultado ser julgado contra o nome em inglês e
      // morrer no filtro, além de não contar nas vagas BR.
      isBr: isBr || looksPtBr(title),
    };
  });
}
