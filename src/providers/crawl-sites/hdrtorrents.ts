// Adaptador do HDRTorrent (hdrtorrents.net) para o motor de raspagem.
//
// ## O site
//
// Oitavo card BR do Jackett e o PRIMEIRO sem sitemap: a descoberta é a
// própria listagem paginada do site (`/pagina/N/`, 20 cards por página). O
// perfil do resolvedor (`resolvers/profiles/hdrtorrents.ts`) é a ponte — pelo
// NOME, como o TorrentDosFilmes e o RedeTorrent, porque o id do card
// (`hdrtorrent-cardigann`) não existe lá. O profile já entrega o que a
// listagem e o post têm de difícil: `parseListingHtml` (os cards) e
// `parseContentMagnets` (os magnets diretos, sem salto de protetor).
//
// ## Medição que o desenho obedece (2026-09-29, site ao vivo)
//
// - `/pagina/1/` … `/pagina/2122/` são reais e sequenciais, 20 cards cada;
//   `/pagina/2123/` é a última (15 cards) e `/pagina/2124/` … `/pagina/99999/`
//   devolvem SEMPRE a 2123. O acervo tem 2123 páginas (bisseção) — daí o teto
//   de páginas por rodada vir de `config.crawl.listingMaxPagesPerRound`.
// - `Invoke-WebRequest` direto responde 200, sem Cloudflare: este site não
//   usa FlareSolverr (ao contrário do RedeTorrent).
// - Post: 1 requisição. O magnet é direto no HTML (`div.download-row` →
//   `a[href^="magnet:"]`), então `requestCost` é 1 e nunca mais.
//
// ## Por que o cursor não é o de data
//
// O card traz `meta[itemprop=datePublished]`, mas o valor é o ANO DA OBRA
// ("Presidente Curtis" 2026, "Os Irregulares de Baker Street" 2021), não a
// data de publicação — usá-lo como `lastmod` faria o motor cortar o acervo pela
// ordem do ano em vez da publicação. O `lastmod` das URLs sai VAZIO e a
// retomada é o cursor de LISTAGEM do motor (ver `listing-discover.ts`).
//
// PORTÃO DE SÉRIE: o post do HDRTorrent declara UMA temporada ("Presidente
// Curtis - 1ª Temporada"), e a temporada e o episódio saem do `<h1>` e do `dn=`
// de cada magnet — é a forma `seasonPageGroups` dos outros três WordPress,
// não a `seriesRowGroups` do RedeTorrent. A página de série entra pela opção
// de séries do painel (`opts.series.enabled`) ou no modo amostra
// (`seriesProbe`); sem as duas, `discover()` não emite `tv_show` e
// `fetchWork(kind:'tv_show')` é erro com ZERO rede.
//
// O portão também entra na IDENTIDADE do cursor de listagem
// (`crawl-listing-series.ts`), e é a parte que fecha o ciclo: a listagem é
// MISTA, então com séries desligadas a página é lida, a URL de série é
// descartada (`listing-discover.ts`) e a página é consumida pelo cursor do
// mesmo jeito. Sem o marcador, a âncora declararia cobertura de série que
// ninguém tem, e ligar séries depois não recuperaria nada. Inverter o portão
// descarta o cursor: a próxima rodada recomeça da página 1.
//
// Travas herdadas: host safety em toda URL derivada de conteúdo do site; o
// `fetchText` do profile é o caminho com FlareSolverr do próprio profile (o
// site responde 200 direto, então ele não aciona); erro carrega o custo
// medido (F1, `withRequestCost`).
import config from '../../config.js';
import { instance } from '../../br-resolvers.js';
import { startListingCursor } from '../crawl-cursor.js';
import { loadListingCursorForSeries, listingCursorCommit } from '../crawl-listing-series.js';
import type {
  CrawlDiscoverOptions, CrawlDiscovery, CrawlPageKind, CrawlPageOptions,
  CrawlReleaseGroup, CrawlSite, CrawlWorkResult,
} from '../crawl-types.js';
import { magnetHash, stripHtmlComments, withRequestCost } from './shared.js';
import { pageSeasonOf, seasonPageGroups, seriesRowGroups, unlocatedReleases } from './season-page.js';
import { walkListing } from './listing-discover.js';
import {
  countListingCards as countRawListingCards, fichaText, isSeasonSlug, isWorkPath,
  declaresSeries, kindConflictOf, kindFromCardType, kindFromWorkSlug, parseImdbId,
} from './hdrtorrents-discovery.js';
import { readWorkTitle } from './work-name.js';
import type { RawItem } from '../../../types/domain.js';

/** Card da listagem, na forma que `parseListingHtml` devolve. */
export interface HdrtorrentsCard {
  url: string;
  title: string;
  year: number | null;
  type: 'Filme' | 'Série' | 'Desenho' | null;
}

/** Link de magnet do profile, no recorte que o adaptador usa. `quality` é
 *  NÚMERO, como no contrato compartilhado do resolver (`ResolverLink`): o
 *  profile classifica a faixa (`normalizeQuality`) e o `releaseTitle` é quem a
 *  escreve no rótulo — o adaptador nunca lê o campo, e declará-lo como texto
 *  aqui só obrigaria quem constrói a superfície a mentir com um cast. */
export interface HdrtorrentsLink {
  url: string;
  quality: number | null;
  size: string | null;
  audio: string | null;
  description?: string | null;
}

/**
 * Superfície do profile que o adaptador usa. Tipada no molde do
 * `BludvResolverSurface`: o profile é uma instância viva (cache, seletor de
 * host, `fetchText`) e este módulo só precisa deste recorte. `releaseTitle`
 * entra junto porque é o profile que monta o rótulo da release — duas cópias
 * das regras de qualidade/áudio divergiriam em silêncio.
 */
export interface HdrtorrentsResolverSurface {
  siteSelector: { url(): string };
  assertAllowedUrl(url: string): URL;
  isDetailHost(hostname: string): boolean;
  isNetworkError(err: unknown): boolean;
  /** `fetchText(url)` — aridade 1 neste profile (não há hook de extração). */
  fetchText(url: string): Promise<string>;
  parseListingHtml(html: string, baseUrl: string): HdrtorrentsCard[];
  parseContentMagnets(html: string, baseUrl: string): HdrtorrentsLink[];
  releaseTitle(post: string, link: HdrtorrentsLink, index: number): string;
}

/**
 * Opções PRÓPRIAS do adaptador. `seriesProbe` é o MODO AMOSTRA: a única
 * passagem autorizada para `kind:'tv_show'` além da opção de séries do painel,
 * e ela existe para a sonda da Fase 8 — nunca para o motor. Mora aqui, e não
 * em `CrawlPageOptions`, porque aquele é o contrato COMPARTILHADO.
 */
export interface HdrtorrentsCrawlOptions {
  seriesProbe?: boolean;
}

/**
 * Resultado da AMOSTRA de temporada: o contrato compartilhado não tem campo
 * para "quantos botões a página anunciava", e é o denominador que a sonda
 * precisa. Quem só enxerga `CrawlWorkResult` continua com o contrato base.
 */
export interface HdrtorrentsSeasonSample extends CrawlWorkResult {
  buttons: number;
}

const SITE_ID = 'hdrtorrent-cardigann';
const TRACKER_LABEL = 'HDRTorrent';
/**
 * Nome do PROFILE, que NÃO é o id do card: o card é `hdrtorrent-cardigann` e
 * o profile é `hdrtorrents` (mesma divergência que
 * `torrentdosfilmesv2`↔`torrentdosfilmes` e `redetorrent-cardigann`↔
 * `redetorrent`). `br-resolvers.instance()` é indexado pelo nome do profile —
 * usar o id do card aqui devolveria `null` e a raspagem seria declarada
 * indisponível em produção.
 */
const RESOLVER_NAME = 'hdrtorrents';
/**
 * Identidade da LISTAGEM no cursor durável: a raiz da PAGINAÇÃO, `/pagina/`
 * (página 1 responde em `/`, que é a homepage). Não pode ser `/`: o
 * `decodeListingCursor` rejeita a raiz como caminho de listagem (ela não
 * identifica listagem nenhuma — `crawlUrlKey('/')` é `'/'`), e o cursor
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
function countedFetchText(surface: HdrtorrentsResolverSurface) {
  let n = 0;
  return {
    fetchText: async (url: string): Promise<string> => {
      n += 1;
      return surface.fetchText(url);
    },
    taken: (): number => n,
  };
}

/** "4 GB" / "6.3 GB" → bytes. A ficha publica um tamanho por post. */
function parseSize(text: string | null | undefined): number | null {
  const match = String(text || '').match(/([\d.,]+)\s*(TB|GB|MB|KB)/i);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  const multiplier = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[
    match[2].toUpperCase() as 'KB' | 'MB' | 'GB' | 'TB'
  ];
  return Number.isFinite(value) ? Math.round(value * multiplier) : null;
}

/**
 * Fábrica do adaptador: recebe a superfície do resolver pronta (nos testes, a
 * instância real do profile com fetch dublê).
 */
export function createHdrtorrentsCrawlSite(
  surface: HdrtorrentsResolverSurface,
  options: HdrtorrentsCrawlOptions = {},
): CrawlSite {
  const seriesProbe = options.seriesProbe === true;

  /** Uma página da listagem → candidatos, já filtrados por host do site. */
  async function readListing(page: number) {
    const base = surface.siteSelector.url();
    const html = await surface.fetchText(page <= 1 ? `${base}/` : `${base}/pagina/${page}/`);
    const posts: Array<{ url: string; kind: CrawlPageKind }> = [];
    const cards = surface.parseListingHtml(html, base);
    let recognizedCount = 0;
    for (const card of cards) {
      recognizedCount += 1;
      // Host de fora do site é recusado aqui — mesma política dos outros
      // adaptadores; o `parseListingHtml` já resolve a URL absoluta.
      try {
        if (!surface.isDetailHost(new URL(card.url).hostname)) continue;
      } catch {
        continue;
      }
      // O `badge-tipo` desempata; quando ele falta ou é "Desenho" (que o site
      // usa para série E para desenho-filme), o SLUG decide — medido em 160
      // cards de 8 páginas: os dois marcadores concordam sempre. O tipo é POR
      // CARD: a página 1 real é MISTA (20 cards, filmes e séries juntos).
      posts.push({ url: card.url, kind: kindFromCardType(card.type) ?? kindFromWorkSlug(card.url) });
    }
    // O fim do catálogo se mede nos cards BRUTOS (ver `listing-discover.ts`).
    return { posts, cardCount: countRawListingCards(html), recognizedCount };
  }

  return {
    id: SITE_ID,
    label: TRACKER_LABEL,

    async discover(_since?: string | null, opts?: CrawlDiscoverOptions): Promise<CrawlDiscovery> {
      const seriesEnabled = seriesProbe || opts?.series?.enabled === true;
      // Uma listagem só, com UM cursor — o tipo de cada card vem do próprio card
      // (badge e slug), e `defaultKind` cobre o card sem tipo declarado. Já
      // houve um ramo que trocava o kind do cursor para `tv_show` quando havia
      // cursor de série: ele nunca era verdadeiro (esta listagem não publica
      // data, então o cursor de série nunca era gravado) e, se fosse, partiria
      // a MESMA listagem em dois cursores — cada um leria o acervo inteiro por
      // conta própria. `movie` é a identidade da listagem; o portão de séries
      // entra pelo marcador, em `loadListingCursorForSeries`.
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
      const commit = walk.pagesConsumed > 0 ? listingCursorCommit(walk.cursor, seriesEnabled, opts) : undefined;
      return {
        urls: walk.urls,
        complete: walk.complete,
        failures: walk.failures, ...(commit ? { commit } : {}),
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
          error: 'hdrtorrent-cardigann: página de temporada fora do motor (séries desligadas no painel)',
        };
      }
      try {
        // Defesa em profundidade: a fila nasce da nossa descoberta, mas o
        // store pode ter sido editado — host de fora é rejeitado na porta, e
        // página que não é de obra (taxonomia, login) também.
        const parsed = surface.assertAllowedUrl(url);
        if (!surface.isDetailHost(parsed.hostname)) throw new Error(`host_fora:${parsed.hostname}`);
        if (!isWorkPath(parsed)) throw new Error('nao-e-pagina-de-obra');
        // Coerência de tipo: gravar o pack de temporada como filme é obra que
        // não existe no catálogo, e o inverso perde a temporada. Quem não
        // classificou por slug é a fila (reprocessar/zera o site) — recusar
        // deixa a linha visível em vez de gravar errado.
        if (!season && isSeasonSlug(parsed)) {
          const error = 'temporada_com_kind_movie: a página é de temporada (pack) e a fila a pediu como filme';
          return { url, status: 'error', error };
        }
        // Série SEM temporada no slug (`castle-torrent-download/`) é a página que
        // AGREGA a série inteira, uma temporada por magnet — a forma do
        // RedeTorrent. Era recusada como "página de filme": 1.624 séries
        // (Castle, Modern Family, Riverdale…) fora do acervo na VPS (2026-10-01).
        // A ficha `TVSeries` numa linha pedida como filme (card sem badge) é lida
        // como série agregada: recusá-la deixou 235 séries em erro na VPS
        // (Dragon Ball Z, Pucca, 2026-10-06) e o reprocesso repetia o erro.
        const html = await counter.fetchText(parsed.href);
        const asSeries = season || (seriesEnabled && declaresSeries(html));
        return buildWork(html, parsed.href, asSeries, surface, counter.taken(), asSeries && !isSeasonSlug(parsed));
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
 * de temporada usa a MESMA `seasonPageGroups` dos outros três WordPress.
 */
function buildWork(
  html: string,
  url: string,
  season: boolean,
  surface: HdrtorrentsResolverSurface,
  requests: number,
  aggregated = false,
): CrawlWorkResult {
  html = stripHtmlComments(html);
  const kindConflict = kindConflictOf(html, season);
  if (kindConflict) return { url, status: 'error', error: kindConflict, requestCost: requests };
  const normalized = fichaText(html);
  const title = readWorkTitle(normalized);
  const imdb = parseImdbId(normalized);
  const links = surface.parseContentMagnets(html, url);
  if (!links.length) return { url, status: 'no-torrent', imdb, requestCost: requests };
  const releases: RawItem[] = [];
  for (const [index, link] of links.entries()) {
    const infoHash = magnetHash(link.url);
    if (!infoHash) continue;
    releases.push({
      infoHash,
      // O magnet INTEIRO, não só o hash: o `dn=` dele é a única evidência de
      // episódio deste site (o rótulo do profile sai "Futurama [1080p WEB-DL
      // DUAL]", sem temporada nem episódio). Sem ele o `seasonPageGroups` via
      // só a temporada do `<h1>` e gravava cada episódio avulso como pack da
      // temporada — medido em 2026-09-29: Futurama S14 com os 9 episódios no
      // grupo `S14`, listados como pack em TODO episódio. É também a URI rica
      // (dn + trackers) que o banco de magnets guarda.
      magnet: link.url,
      title: surface.releaseTitle(title.title, link, index),
      tracker: TRACKER_LABEL,
      // Fonte BR não publica seeder: 1 é o valor neutro (0 seria descartado
      // pelo filtro de seeders antes de o card ser visto).
      seeders: 1,
      // A ficha publica um tamanho por post; ausente é `undefined`, nunca 0
      // (que o filtro de tamanho leria como torrent de tamanho zero).
      ...(parseSize(link.size) != null ? { size: parseSize(link.size) as number } : {}),
      isBr: true,
      indexer: SITE_ID,
    });
  }
  if (!releases.length) return { url, status: 'no-torrent', imdb, requestCost: requests };
  if (season && aggregated) {
    // Locação por LINHA, só pelo `dn=`; linha sem temporada nunca vai à raiz (vai em `unlocated`,
    // ver o tipo). `season` = maior declarada: abre a janela `seriesStartedBy`.
    const groups = seriesRowGroups(releases.map((release) => ({ release, rowSeason: null })));
    const unlocated = unlocatedReleases(releases, groups);
    if (!groups.length && !unlocated.length) return { url, status: 'no-torrent', imdb, requestCost: requests };
    const maxSeason = groups.reduce<number | null>((m, g) => (g.season != null && (m == null || g.season > m) ? g.season : m), null);
    return {
      url, status: 'done', type: 'series', title: title.title, year: title.year,
      imdb, season: maxSeason, groups, unlocated, requestCost: requests,
    };
  }
  if (season) {
    const pageSeason = pageSeasonOf(title.title, url);
    const groups: CrawlReleaseGroup[] = seasonPageGroups(releases, {
      season: pageSeason, title: title.title,
    });
    return {
      url, status: 'done', type: 'series', title: title.title, year: title.year,
      imdb, season: pageSeason, groups, requestCost: requests,
    };
  }
  return {
    url, status: 'done', type: 'movie', title: title.title, year: title.year,
    imdb, releases, requestCost: requests,
  };
}

/**
 * Instância de produção: reusa o resolver hdrtorrents JÁ CARREGADO no processo
 * (mesmo seletor de domínio, mesmos caches). É este export que o registry
 * chama, e ele NUNCA liga `seriesProbe`: em produção a página de temporada
 * entra pela opção de séries do painel.
 */
export function hdrtorrentsCrawlSite(): CrawlSite {
  const surface = instance(RESOLVER_NAME) as HdrtorrentsResolverSurface | null;
  if (!surface || typeof surface.fetchText !== 'function') {
    throw new Error('hdrtorrent-cardigann: resolvedor embutido não carregado — raspagem indisponível');
  }
  return createHdrtorrentsCrawlSite(surface);
}
