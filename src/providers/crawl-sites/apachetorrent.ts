// Adaptador do Apache Torrents (apachetorrents.com) para o motor de raspagem.
// Último dos três cards BR que ainda estava com `module: null` no registro.
//
// ## O site
//
// Catálogo PHP próprio (não é WordPress) — o formato medido do card, do slug e
// da ficha está em `apachetorrent-discovery.ts`, que é também onde mora a
// extração do card (o profile não tem parser de listagem). A descoberta é a
// PRÓPRIA LISTAGEM paginada (`/pagina/N/`, 20 cards por página), o mesmo
// desenho do HDRTorrent, e por isso o `walkListing` inteiro é REUSADO — com o
// mesmo cursor, o mesmo `loadListingCursorForSeries`/`saveListingCursorForSeries`
// e a mesma identidade de listagem (`LISTING_PATH`).
//
// O perfil do resolvedor (`resolvers/profiles/apachetorrent.ts`) é a ponte —
// pelo NOME, como o TorrentDosFilmes, o RedeTorrent e o HDRTorrent, porque o
// id do card (`apachetorrent-cardigann`) não existe lá. O profile entrega o que
// o post tem de difícil (`parsePostMagnets`, `releaseTitle`) e o transporte
// (`fetchText`); o que ele NÃO tem é parser de listagem — a extração do card é
// a REGRA PURA de `apachetorrent-discovery.ts`.
//
// ## Medição que o desenho obedece (2026-09-29, site ao vivo)
//
// - `/pagina/1/` e `/` são a mesma página (20 cards); `/pagina/2123/` é a
//   ÚLTIMA e tem 15; `/pagina/2124/` … `/pagina/99999/` devolvem SEMPRE a
//   2123. Não existe `<link rel="last">` nem `<link rel="next">` — a
//   paginação é só o `<ul class="pagination">` do rodapé, e o motor não a
//   segue: ele deriva a página do cursor.
// - `Invoke-WebRequest` direto responde 200, sem Cloudflare: este site não usa
//   FlareSolverr (ao contrário do RedeTorrent).
// - Post: 1 requisição. O magnet é direto no HTML (`div.download-block` →
//   `a[href^="magnet:"]`), então `requestCost` é 1 e nunca mais. A SESSÃO
//   (cookie PHPSESSID + token) é só da busca: `fetchText` do post é público.
//
// ## Por que o cursor não é o de data
//
// O card declara o ANO DO ACERVO por extenso ("(Filme de 2019)"), não a data
// de publicação — usá-lo como `lastmod` faria o motor cortar o acervo pela
// ordem do ano em vez da publicação. `lastmod` sai VAZIO e a retomada é o
// cursor de LISTAGEM (ver `listing-discover.ts`).
//
// ## PORTÃO DE SÉRIE
//
// O post do Apache declara UMA temporada ("Lanternas - 1ª Temporada"), e a
// temporada e o episódio saem do `<h1>` e do `dn=` de cada magnet — é a forma
// `seasonPageGroups` dos outros sites, não a `seriesRowGroups` do RedeTorrent.
// A página de série entra pela opção de séries do painel (`opts.series.enabled`)
// ou no modo amostra (`seriesProbe`); sem as duas, `discover()` não emite
// `tv_show` e `fetchWork(kind:'tv_show')` é erro com ZERO rede.
//
// O portão também entra na IDENTIDADE do cursor de listagem
// (`crawl-listing-series.ts`): a listagem é MISTA, então com séries desligadas
// a página é lida, a URL de série é descartada e a página é consumida pelo
// cursor do mesmo jeito. Sem o marcador, ligar séries depois não recuperaria
// nada — e o caminho inverso (parar a varredura) releria as mesmas páginas
// para sempre. Inverter o portão descarta o cursor: a próxima rodada recomeça
// da página 1.
//
// ## A coerência de tipo é de DUAS fases, e a segunda precisa do post
//
// `temporada_com_kind_movie` sai ANTES de qualquer rede: o slug com temporada
// prova que a página é de pack de temporada, e gravar isso como filme é obra
// que não existe no catálogo.
//
// `filme_com_kind_tv_show` NÃO pode: a URL não prova o contrário. Medido em
// 2026-09-29 em 6 páginas reais (120 cards), 2 declaram `(Série de …)` SEM
// temporada no slug — "Avante - Nos Bastidores de X-Men 97 - Legendada" e "Os
// Filhos da Guerra" — e são séries reais, não filmes. Uma recusa por
// "sem temporada no slug ⇒ é filme" mataria as duas na porta, com a fila
// cheia de erro que nunca se resolve. Por isso a segunda coerência sai do
// PRÓPRIO POST, que declara o tipo no `<p class="item-lead">` ("… Download
// Torrent Filme de 2019 …", medido nos 4 posts reais), e a rede gasta é
// reportada no `requestCost` como deve ser.
//
// Travas herdadas: host safety em toda URL derivada de conteúdo do site; o
// `fetchText` do profile é o caminho com FlareSolverr do próprio profile (o
// site responde 200 direto, então ele não aciona); erro carrega o custo
// medido (F1, `withRequestCost`).
import config from '../../config.js';
import { instance } from '../../br-resolvers.js';
import { startListingCursor } from '../crawl-cursor.js';
import { loadListingCursorForSeries, saveListingCursorForSeries } from '../crawl-listing-series.js';
import type {
  CrawlDiscoverOptions, CrawlDiscovery, CrawlPageKind, CrawlPageOptions,
  CrawlReleaseGroup, CrawlSite, CrawlWorkResult,
} from '../crawl-types.js';
import { magnetHash, withRequestCost } from './shared.js';
import { pageSeasonOf, seasonPageGroups } from './season-page.js';
import { walkListing } from './listing-discover.js';
import {
  fichaOriginalTitle, fichaSizeBytes, isSeasonSlug, isWorkPath, pageKindOf, parseImdbId,
  parseListingCards,
} from './apachetorrent-discovery.js';
import { readWorkTitle } from './work-name.js';
import type { RawItem } from '../../../types/domain.js';

/** Link de magnet do profile, no recorte que o adaptador usa. `quality` é
 *  NÚMERO, como no contrato compartilhado do resolver (`ParsedResolverLink`):
 *  o profile classifica a faixa e o `releaseTitle` é quem a escreve no rótulo —
 *  o adaptador nunca lê o campo. */
export interface ApacheLink {
  url: string;
  quality: number | null;
  size: string | null;
  audio: string | null;
  description?: string | null;
}

/**
 * Superfície do profile que o adaptador usa. Tipada no molde da
 * `HdrtorrentsResolverSurface`: o profile é uma instância viva (seletor de
 * host, sessão, `fetchText`) e este módulo só precisa deste recorte.
 * `releaseTitle` entra junto porque é o profile que monta o rótulo da
 * release — duas cópias das regras de qualidade/áudio divergiriam em silêncio.
 */
export interface ApacheResolverSurface {
  siteSelector: { url(): string };
  assertAllowedUrl(url: string): URL;
  isDetailHost(hostname: string): boolean;
  isNetworkError(err: unknown): boolean;
  /** `fetchText(url)` — aridade 1 neste profile (o post não usa sessão). */
  fetchText(url: string): Promise<string>;
  parsePostMagnets(html: string, baseUrl: string): ApacheLink[];
  releaseTitle(post: string, link: ApacheLink, index: number): string;
}

/**
 * Opções PRÓPRIAS do adaptador. `seriesProbe` é o MODO AMOSTRA: a única
 * passagem autorizada para `kind:'tv_show'` além da opção de séries do painel,
 * e ela existe para a sonda da Fase 8 — nunca para o motor.
 */
export interface ApacheCrawlOptions {
  seriesProbe?: boolean;
}

const SITE_ID = 'apachetorrent-cardigann';
const TRACKER_LABEL = 'ApacheTorrent';
/**
 * Nome do PROFILE, que NÃO é o id do card: o card é
 * `apachetorrent-cardigann` e o profile é `apachetorrent` (mesma divergência
 * que `torrentdosfilmesv2`↔`torrentdosfilmes`, `redetorrent-cardigann`↔
 * `redetorrent` e `hdrtorrent-cardigann`↔`hdrtorrents`). `br-resolvers
 * .instance()` é indexado pelo nome do profile — usar o id do card aqui
 * devolveria `null` e a raspagem seria declarada indisponível em produção.
 */
const RESOLVER_NAME = 'apachetorrent';
/**
 * Identidade da LISTAGEM no cursor durável: a raiz da PAGINAÇÃO, `/pagina/`.
 * Página 1 responde tanto em `/` quanto em `/pagina/1/` (medido: as duas
 * devolvem os mesmos 20 cards), e a raiz `/` não serve como identidade — o
 * `decodeListingCursor` a rejeita como caminho de listagem, e o cursor
 * recomeçaria da página 1 a cada rodada.
 */
const LISTING_PATH = '/pagina/';
/** Cards por página: medido em `/pagina/1..2122` contra a última real (15). */
const CARDS_PER_PAGE = 20;

/** `seriesProbe` por CHAMADA: o `CrawlPageOptions` compartilhado não tem o
 *  campo e não é meu para mudar — cast concentrado aqui, leitura por `=== true`. */
function probeRequested(pageOpts?: CrawlPageOptions): boolean {
  return (pageOpts as { seriesProbe?: unknown } | undefined)?.seriesProbe === true;
}

/** `fetchText` que CONTA — o `requestCost` é medido, não estimado. */
function countedFetchText(surface: ApacheResolverSurface) {
  let n = 0;
  return {
    fetchText: async (url: string): Promise<string> => {
      n += 1;
      return surface.fetchText(url);
    },
    taken: (): number => n,
  };
}

/**
 * Fábrica do adaptador: recebe a superfície do resolver pronta (nos testes, a
 * instância real do profile com fetch dublê).
 */
export function createApachetorrentCrawlSite(
  surface: ApacheResolverSurface,
  options: ApacheCrawlOptions = {},
): CrawlSite {
  const seriesProbe = options.seriesProbe === true;

  /** Uma página da listagem → candidatos, já filtrados por host do site. */
  async function readListing(page: number) {
    const base = surface.siteSelector.url();
    const html = await surface.fetchText(page <= 1 ? `${base}/` : `${base}${LISTING_PATH}${page}/`);
    const posts: Array<{ url: string; kind: CrawlPageKind }> = [];
    for (const card of parseListingCards(html, base)) {
      // Host de fora do site é recusado aqui — mesma política dos outros
      // adaptadores; a regra pura já resolveu a URL, mas ela não conhece a
      // allowlist do profile, e quem conhece é a instância viva.
      try {
        if (!surface.isDetailHost(new URL(card.url).hostname)) continue;
      } catch {
        continue;
      }
      posts.push({ url: card.url, kind: card.kind });
    }
    return { posts };
  }

  return {
    id: SITE_ID,
    label: TRACKER_LABEL,

    async discover(_since?: string | null, opts?: CrawlDiscoverOptions): Promise<CrawlDiscovery> {
      const seriesEnabled = seriesProbe || opts?.series?.enabled === true;
      // Uma listagem só, com UM cursor — `movie` é a identidade da listagem
      // (o tipo de cada URL é decidido pelo CARD, e `defaultKind` cobre o card
      // sem tipo declarado). O portão de séries entra pelo marcador, em
      // `loadListingCursorForSeries`.
      const listingKind: CrawlPageKind = 'movie';
      const now = Date.now();
      const cursor = loadListingCursorForSeries(SITE_ID, listingKind, LISTING_PATH, seriesEnabled)
        ?? startListingCursor(SITE_ID, listingKind, LISTING_PATH, now);
      const walk = await walkListing({
        readPage: readListing,
        expectedPerPage: CARDS_PER_PAGE,
        budget: { maxPagesPerRound: config.crawl.listingMaxPagesPerRound },
        seriesEnabled,
        defaultKind: listingKind,
        cursor,
        now,
      });
      // O cursor de listagem é durável: sem esta gravação a próxima rodada
      // releria a página 1 e a varredura nunca passaria da vigésima. O marcador
      // do portão viaja junto (`crawl-listing-series.ts`) — é ele que faz a
      // inversão do portão recomeçar a varredura em vez de pular o acervo de
      // série que a rodada anterior leu e descartou.
      if (walk.pagesConsumed > 0) saveListingCursorForSeries(walk.cursor, seriesEnabled);
      return {
        urls: walk.urls,
        complete: walk.complete,
        failures: walk.failures,
        // A listagem é a MESMA fonte dos dois kinds (a página é mista), então a
        // completude é uma só. Com séries desligadas ela cobre só o que foi
        // emitido: as URLs de série foram lidas e DESCARTADAS, logo `tv_show`
        // sai `false` em vez de `true` — é a afirmação honesta, e o valor é
        // inerte hoje de qualquer modo (sem `lastmod`, o cursor de série não
        // anda mesmo; `advanceCursors` exige um `max`).
        completeByKind: { movie: walk.complete, tv_show: seriesEnabled ? walk.complete : false },
        // Custo REAL: as requisições que a rodada fez ao site, incluindo a
        // página que falhou (o request saiu). É o que o teto por hora cobra.
        requestCost: walk.requests,
      };
    },

    async fetchWork(url: string, pageOpts?: CrawlPageOptions): Promise<CrawlWorkResult> {
      const counter = countedFetchText(surface);
      const season = pageOpts?.kind === 'tv_show';
      const seriesEnabled = seriesProbe || probeRequested(pageOpts) || pageOpts?.series?.enabled === true;
      if (season && !seriesEnabled) {
        // Séries desligadas: linha de temporada na fila vira erro explicado,
        // ZERO rede — a recusa é do portão, não do site.
        return {
          url,
          status: 'error',
          error: 'apachetorrent-cardigann: página de temporada fora do motor (séries desligadas no painel)',
        };
      }
      try {
        // Defesa em profundidade: a fila nasce da nossa descoberta, mas o
        // store pode ter sido editado — host de fora é rejeitado na porta, e
        // página que não é de obra (taxonomia, busca) também.
        const parsed = surface.assertAllowedUrl(url);
        if (!surface.isDetailHost(parsed.hostname)) throw new Error(`host_fora:${parsed.hostname}`);
        if (!isWorkPath(parsed)) throw new Error('nao-e-pagina-de-obra');
        // Coerência de tipo, FASE 1 (sem rede): o slug com temporada prova que
        // a página é de pack de temporada, e gravar isso como filme é obra que
        // não existe no catálogo. Quem não classificou é a fila
        // (reprocessar/zera o site) — recusar deixa a linha visível em vez de
        // gravar errado. A fase 2 (filme pedido como série) fica no post, ver
        // o cabeçalho.
        if (!season && isSeasonSlug(parsed)) {
          return {
            url,
            status: 'error',
            error: 'temporada_com_kind_movie: a página é de temporada (pack) e a fila a pediu como filme',
          };
        }
        const html = await counter.fetchText(parsed.href);
        return buildWork(html, parsed.href, season, surface, counter.taken());
      } catch (err) {
        // F1: throw NÃO perde o custo medido.
        throw withRequestCost(err, counter.taken());
      }
    },
  };
}

/**
 * Post → `CrawlWorkResult`. O `releaseTitle` do profile monta o rótulo da
 * release a partir do texto do post (é o que dá o `[1080p DUAL]`), e a lista
 * de temporada usa a MESMA `seasonPageGroups` dos outros sites.
 */
function buildWork(
  html: string,
  url: string,
  season: boolean,
  surface: ApacheResolverSurface,
  requests: number,
): CrawlWorkResult {
  // Coerência de tipo, FASE 2: agora que o post foi lido, o tipo declarado
  // nele decide. "Filme de YYYY" numa página pedida como série é conteúdo
  // errado — devolver 404/erro aqui é o que a fila de `movie` não alcança.
  const declaredKind = pageKindOf(html);
  if (season && declaredKind === 'movie') {
    return {
      url,
      status: 'error',
      error: 'filme_com_kind_tv_show: a fila pediu série e o post declara filme',
      requestCost: requests,
    };
  }
  // A ficha do Apache é `<strong>Rótulo</strong>: valor` — o mesmo formato que
  // as regras compartilhadas (`work-name.ts`, `shared.ts`) já leem, então não
  // há normalização de marcação aqui: ao contrário do HDRTorrent, este site
  // não usa `<dt>/<dd>` (medido: zero ocorrências nos 4 posts reais).
  const title = readWorkTitle(html);
  const imdb = parseImdbId(html);
  const originalTitle = fichaOriginalTitle(html);
  // Um tamanho por POST na ficha (não por botão): o site não publica o do
  // botão, e inventar 0 seria pior que não declarar.
  const size = fichaSizeBytes(html);
  const links = surface.parsePostMagnets(html, url);
  if (!links.length) {
    return { url, status: 'no-torrent', imdb, title: title.title, year: title.year, originalTitle, requestCost: requests };
  }
  const releases: RawItem[] = [];
  for (const [index, link] of links.entries()) {
    const infoHash = magnetHash(link.url);
    if (!infoHash) continue;
    releases.push({
      infoHash,
      // O magnet INTEIRO, não só o hash — mesma regra do HDRTorrent: o `dn=`
      // é a única evidência de episódio do post (o rótulo sai "Futurama
      // [1080p WEB-DL DUAL]"), e sem ele o `seasonPageGroups` mandava TODO
      // botão para o grupo da temporada. Medido em 2026-09-29: Futurama S14
      // com 9 episódios num grupo `S14`, Ted Lasso S4 com 8 — cada episódio
      // listado como pack em todo episódio. É também a URI rica do banco.
      magnet: link.url,
      title: surface.releaseTitle(title.title, link, index),
      // Fonte BR não publica seeder: 1 é o valor neutro (0 seria descartado
      // pelo filtro de seeders antes de o card ser visto).
      seeders: 1,
      // Ausente é `undefined`, nunca 0 (que o filtro de tamanho leria como
      // torrent de tamanho zero).
      ...(size != null ? { size } : {}),
      isBr: true,
      indexer: SITE_ID,
    });
  }
  if (!releases.length) return { url, status: 'no-torrent', imdb, title: title.title, year: title.year, originalTitle, requestCost: requests };
  if (season) {
    const pageSeason = pageSeasonOf(title.title, url);
    const groups: CrawlReleaseGroup[] = seasonPageGroups(releases, {
      season: pageSeason, title: title.title,
    });
    return {
      url, status: 'done', type: 'series', title: title.title, year: title.year,
      imdb, originalTitle, season: pageSeason, groups, requestCost: requests,
    };
  }
  return {
    url, status: 'done', type: 'movie', title: title.title, year: title.year,
    imdb, originalTitle, releases, requestCost: requests,
  };
}

/**
 * Instância de produção: reusa o resolver apachetorrent JÁ CARREGADO no
 * processo (mesmo seletor de domínio, mesmos caches, mesma sessão). É este
 * export que o registry chama, e ele NUNCA liga `seriesProbe`: em produção a
 * página de temporada entra pela opção de séries do painel.
 */
export function apachetorrentCrawlSite(): CrawlSite {
  const surface = instance(RESOLVER_NAME) as ApacheResolverSurface | null;
  if (!surface || typeof surface.fetchText !== 'function') {
    throw new Error('apachetorrent-cardigann: resolvedor embutido não carregado — raspagem indisponível');
  }
  return createApachetorrentCrawlSite(surface);
}
