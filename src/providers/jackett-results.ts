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
 * Indexers que, além de devolver ZERO quando a query leva `Category[]`, têm o
 * `Category` da resposta inútil para filtrar o tipo.
 *
 * A definition stock do MagnetDownload só declara `Other/8000`, então um filtro
 * local por balde (2000 ff./5000 ff.) descartaria TODO o acervo — mesmo que a
 * query saia sem categoria, o `mapResults` faria o mesmo estrago que o
 * parámetro na URL. Aqui URL e local saem desligados de propósito: a
 * relevância/título (`filterRelevantRaw`, `matchesBrTitle`) controla sozinha.
 * Isolado do TPB porque ele consegue filtrar local pelo `Category` da
 * resposta — neste indexer o campo nem distingue filme de série.
 */
export const UNRELIABLE_CATEGORY_INDEXERS = new Set(['magnetdownload']);

/**
 * Indexers cujo uploader classifica filme como "Other" (8000) — o
 * `Category[]=2000` na URL escondia o release ANTES de chegar ao addon.
 * Medido no LimeTorrents (2026-09-24, 18 filmes): sem a categoria, 0
 * relevante perdido e 16 a mais nas buscas EN, e 11 dublados PT vivos que
 * nunca apareciam — "Interestelar (2014) BluRay 1080p Dublado" com 114
 * seeders, "Apocalypse Now (1979) … 720p Dublado AndreTPF" com 30, todos 8000.
 * A consulta sai sem categoria e o filtro local trata Other como
 * desconhecido; áudio/jogo/livro e o tipo errado (série na busca de filme)
 * continuam fora.
 */
export const OTHER_AS_UNKNOWN_INDEXERS = new Set(['limetorrents']);

/**
 * Balde Torznab do tipo: 2000–2999 = filme, 5000–5999 = TV. O `Category` do
 * Jackett traz o id fino (2040 = Movies/HD) junto de ids de tracker fora da
 * faixa Torznab (100207), então o teste é por faixa. Resultado sem categoria
 * nenhuma passa: perder release por metadado ausente é pior que deixar entrar
 * um fora de tipo, que o matchContext ainda descarta depois.
 */
export function inCategoryBucket(categories: any, bucket: number, { otherAsUnknown = false }: { otherAsUnknown?: boolean } = {}) {
  if (!Array.isArray(categories) || categories.length === 0) return true;
  if (categories.some((id: any) => Number(id) >= bucket && Number(id) < bucket + 1000)) return true;
  if (!otherAsUnknown) return false;
  // Só a faixa Torznab (< 10000) diz o tipo; ids do tracker (127246) não.
  // Nenhum id Torznab além de Other (8000–8999) = tipo desconhecido, passa.
  const torznab = categories.map(Number).filter((id: number) => id > 0 && id < 10000);
  return torznab.every((id: number) => id >= 8000 && id < 9000);
}

export function mapResults(
  data: any,
  { isBr = false, indexer = '', categoryBucket = 0, otherAsUnknown = false }:
    { isBr?: boolean; indexer?: string; categoryBucket?: number; otherAsUnknown?: boolean } = {},
) {
  const all = Array.isArray(data?.Results) ? data.Results : Array.isArray(data) ? data : [];
  const results = categoryBucket
    ? all.filter((r: any) => inCategoryBucket(r?.Category, categoryBucket, { otherAsUnknown }))
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

/**
 * Falha da FONTE dentro de uma resposta HTTP 200. O Jackett não propaga o erro
 * do indexer no código HTTP: quando o site (ou o resolver embutido) está fora,
 * ele devolve 200 com `Results: []` e a falha descrita em
 * `Indexers[].Status`/`Error`.
 *
 * Medido ao vivo no nerdfilmes: o site migrou para um domínio sem DNS, o
 * resolver da 8702 passou a devolver 502 e toda busca voltava
 * `Status: 1, Error: "…BadGateway - The tracker seems to be down"` — com HTTP
 * 200 por fora. Quem só olhava o transporte gravava `ok: true`, então o card
 * ficava verde, o failStreak nunca subia, o circuit breaker nunca abria e o
 * alerta `indexer_down` (que existe justamente para fonte BR caída) nunca
 * disparava. A fonte ficou fora sem um único sinal, queimando orçamento de
 * busca em toda consulta.
 *
 * `Status: 2` é o OK do Jackett; qualquer outro valor, ou um `Error` não nulo,
 * é falha da fonte. Resposta sem o envelope `Indexers` (array cru, dublê de
 * teste) não afirma nada e devolve null — ausência de prova não é prova de
 * falha, e transformá-la em falha pintaria de vermelho todo indexer sadio.
 */
export function indexerFailure(data: any): string | null {
  const envelope = Array.isArray(data?.Indexers) ? data.Indexers : null;
  if (!envelope?.length) return null;
  for (const entry of envelope) {
    const erro = entry?.Error;
    const status = entry?.Status;
    // Só a primeira linha: o Error do Jackett carrega o stack trace .NET
    // inteiro, e ele não cabe num card nem num log de uma linha.
    if (erro) return String(erro).split(/\r?\n/)[0].slice(0, 200);
    if (status != null && Number(status) !== 2) return `Status ${status}`;
  }
  return null;
}
