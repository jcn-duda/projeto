// Adaptador de raspagem do ComandoTorrents (Fase 8). O motor cuida de fila,
// ritmo e gravação; aqui só existem `discover()` (índice Yoast →
// `post-sitemap*.xml` → obras com lastmod e tipo pelo slug) e `fetchWork()`
// (post → botões do coletor → magnet), sempre pelo resolver já carregado.
// As regras puras ficam em `comandotorrents-discovery.ts`.
//
// PORTÃO DE SÉRIE. O sitemap é misto: slug com "temporada" é página que
// mistura episódio avulso e pack. Ela entra no motor com a opção de SÉRIES
// ligada (`opts.series.enabled`, a mesma do Vaca) ou no modo amostra
// (`seriesProbe`); sem as duas, `discover()` não a emite e o `fetchWork` é
// erro com zero rede. O `dn=` declara episódio ou pack em 49 de 50 botões
// (medido 2026-09-28) e cada botão nasce na locação dele (`season-page.ts`).
// Página de temporada pedida como filme continua recusada.
//
// Travas: host do site em toda URL derivada do sitemap; fetch direto sem
// FlareSolverr; descoberta parcial não derruba a rodada; erro carrega o
// custo medido. Nada aqui grava banco, agenda nada nem liga o crawler.
import config from '../../config.js';
import type { RawItem } from '../../../types/domain.js';
import type { ResolverLink } from '../../../resolvers/types.js';
import type { ReleaseTitleInput, ReleaseTitlePost } from '../../../resolvers/release-format.js';
import type {
  CrawlDiscovery, CrawlPageKind, CrawlPageOptions, CrawlSite, CrawlWorkResult, CrawlDiscoverOptions, DiscoveredUrl,
} from '../crawl-types.js';
import { instance } from '../../br-resolvers.js';
import * as log from '../../utils/logger.js';
import { magnetHash, parseOriginalTitle, withRequestCost } from './shared.js';
import { assertSitemapScope } from './sitemap-guard.js';
import { pageSeasonOf, seasonPageGroups } from './season-page.js';
import { h1Text } from './work-name.js';
import {
  isSeasonSlug, isWorkPath, kindFromSlug, parseImdbId, parseSitemapEntries,
  parseSitemapIndexLocs, SITEMAP_INDEX_PATHS, toWorkUrl, workTitleYear,
} from './comandotorrents-discovery.js';

/**
 * Recorte da instância do profile que o adaptador consome. O compilador cobra
 * estes métodos contra a API real — quebra se o profile renomear algo.
 */
export interface ComandotorrentsResolverSurface {
  siteSelector: { url(): string };
  assertAllowedUrl(value: string | null | undefined): URL;
  isDetailHost(hostname: string | null | undefined): boolean;
  fetchTextDirect(url: string, accept?: string, hooks?: { onRequest?: () => void }): Promise<string>;
  parseDownloadLinks(html: string | null | undefined, baseUrl?: string): ResolverLink[];
  fetchFollowingAllowed(value: string, referer?: string | null, hooks?: { onRequest?: () => void }): Promise<string>;
  extractMagnet(html: string | null | undefined): string | null;
  releaseTitle(post: ReleaseTitlePost, link: ReleaseTitleInput, index?: number | null): string;
  parseSize(text: string | null | undefined): number | null;
}

/**
 * `seriesProbe` é o modo amostra: a única passagem para `kind:'tv_show'`.
 * Mora aqui, e não em `CrawlPageOptions`, porque aquele contrato é de todos
 * os sites. `fetchWork` também lê a flag por chamada (`probeRequested`).
 */
export interface ComandotorrentsCrawlOptions {
  seriesProbe?: boolean;
}

/** Amostra de temporada: contagem de botões sem afirmar locação (`groups`). */
export interface ComandotorrentsSeasonSample extends CrawlWorkResult {
  buttons: number;
  buttonsFollowed: number;
}

/** id do card do Jackett (o profile tem o mesmo nome). */
const SITE_ID = 'comandotorrents';
const TRACKER_LABEL = 'ComandoTorrents';
const RESOLVER_NAME = 'comandotorrents';

function probeRequested(pageOpts?: CrawlPageOptions): boolean {
  return (pageOpts as { seriesProbe?: unknown } | undefined)?.seriesProbe === true;
}

/** Cadeia do protetor que não vai passar a ter magnet: não retentar. */
function isTerminalButtonError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /protector_(?:link_expired|non_magnet)/i.test(message);
}

function releaseToRawItem(
  surface: ComandotorrentsResolverSurface,
  obra: { title: string; year: number | null },
  link: ResolverLink,
  magnet: string,
): RawItem {
  return {
    title: surface.releaseTitle({ title: obra.title, year: obra.year }, link),
    magnet,
    indexer: SITE_ID,
    tracker: TRACKER_LABEL,
    // Origem BR é campo do provider. Fonte BR não publica swarm; 1 sobrevive
    // ao MIN_SEEDERS.
    isBr: true,
    seeders: 1,
    size: surface.parseSize(link.size) ?? undefined,
  };
}

/**
 * Fábrica do adaptador. Nos testes a superfície é o profile real com fetch
 * dublê; em produção, `comandotorrentsCrawlSite()` passa a instância embutida.
 */
export function createComandotorrentsCrawlSite(
  surface: ComandotorrentsResolverSurface,
  options: ComandotorrentsCrawlOptions = {},
): CrawlSite {
  const seriesProbe = options.seriesProbe === true;

  function assertSiteUrl(value: string): URL {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error('invalid_url'); }
    if (!surface.isDetailHost(parsed.hostname)) {
      throw new Error(`blocked_host:${parsed.hostname.toLowerCase()}`);
    }
    return surface.assertAllowedUrl(value);
  }

  async function readSitemapIndex(onRequest: () => void): Promise<string> {
    const base = surface.siteSelector.url();
    const failures: string[] = [];
    for (const p of SITEMAP_INDEX_PATHS) {
      const url = new URL(p, base).href;
      try {
        const xml = await surface.fetchTextDirect(url, undefined, { onRequest });
        if (parseSitemapIndexLocs(xml, base, (h) => surface.isDetailHost(h)).length) return xml;
        failures.push(`${url}: nenhum post-sitemap no índice`);
      } catch (err) {
        failures.push(`${url}: ${log.errorMessage(err)}`);
      }
    }
    throw new Error(`comandotorrents: índice de sitemaps ilegível (${failures.join(' | ')})`);
  }

  async function readWorkSitemap(
    loc: string,
    sinceOf: (kind: CrawlPageKind) => string | null,
    onRequest: () => void,
  ): Promise<DiscoveredUrl[]> {
    const xml = await surface.fetchTextDirect(loc, undefined, { onRequest });
    const out: DiscoveredUrl[] = [];
    const entries = parseSitemapEntries(xml);
    let accepted = 0;
    for (const entry of entries) {
      const href = toWorkUrl(entry.loc, loc, (h) => surface.isDetailHost(h));
      if (!href) continue;
      accepted += 1;
      const kind = kindFromSlug(href);
      const since = sinceOf(kind);
      if (since) {
        const t = Date.parse(entry.lastmod);
        const floor = Date.parse(since);
        if (Number.isFinite(t) && Number.isFinite(floor) && t <= floor) continue;
      }
      out.push({ url: href.href, lastmod: entry.lastmod, kind });
    }
    assertSitemapScope(entries.length, accepted);
    return out;
  }

  return {
    id: SITE_ID,
    label: TRACKER_LABEL,

    async discover(since?: string | null, opts?: CrawlDiscoverOptions): Promise<CrawlDiscovery> {
      const emitSeries = seriesProbe || opts?.series?.enabled === true;
      const sinceByKind = opts?.sinceByKind;
      const sinceOf = (kind: CrawlPageKind): string | null => (
        sinceByKind && Object.prototype.hasOwnProperty.call(sinceByKind, kind)
          ? (sinceByKind[kind] ?? null)
          : (since ?? null)
      );
      const counter = { n: 0 };
      const countRequest = () => { counter.n += 1; };
      const base = surface.siteSelector.url();
      const indexXml = await readSitemapIndex(countRequest);
      const sitemaps = parseSitemapIndexLocs(indexXml, base, (h) => surface.isDetailHost(h));
      if (!sitemaps.length) throw new Error('comandotorrents: nenhum post-sitemap no índice');
      const all: DiscoveredUrl[] = [];
      const failures: string[] = [];
      for (const loc of sitemaps) {
        try {
          all.push(...await readWorkSitemap(loc, sinceOf, countRequest));
        } catch (err) {
          failures.push(`${loc}: ${log.errorMessage(err)}`);
          log.warn(`[crawl] comandotorrents: sitemap falhou (${loc}):`, log.errorMessage(err));
        }
      }
      if (!all.length && failures.length === sitemaps.length) {
        throw new Error('comandotorrents: todos os post-sitemaps falharam');
      }
      const complete = failures.length === 0;
      return {
        urls: emitSeries ? all : all.filter((u) => u.kind === 'movie'),
        complete,
        failures,
        // O `post-sitemap` mistura filmes e séries: arquivo ilegível não prova
        // completude de nenhum tipo, mesmo com séries fora do gate nesta rodada.
        completeByKind: { movie: complete, tv_show: complete },
        requestCost: counter.n,
      };
    },

    async fetchWork(url: string, pageOpts?: CrawlPageOptions): Promise<CrawlWorkResult> {
      const season = pageOpts?.kind === 'tv_show';
      if (season && !seriesProbe && !probeRequested(pageOpts) && pageOpts?.series?.enabled !== true) {
        const message = 'comandotorrents: página de temporada fora do motor (séries desligadas no painel)';
        log.warn(`[crawl] ${message}: ${url}`);
        return { url, status: 'error', error: message };
      }
      const counter = { n: 0 };
      const countRequest = () => { counter.n += 1; };
      try {
        const workUrl = assertSiteUrl(url);
        if (!isWorkPath(workUrl)) {
          throw new Error(`not_a_work_page:${workUrl.pathname.toLowerCase()}`);
        }
        if (!season && isSeasonSlug(workUrl)) {
          const message = 'temporada_com_kind_movie: a página é de temporada e a fila a pediu como filme';
          log.warn(`[crawl] comandotorrents: ${message}: ${url}`);
          return { url, status: 'error', error: message };
        }
        const pageHtml = await surface.fetchTextDirect(workUrl.href, undefined, { onRequest: countRequest });
        const { title, year } = workTitleYear(pageHtml);
        if (!title) {
          return { url, status: 'error', error: 'layout: página sem <h1> de título', requestCost: counter.n };
        }
        const imdb = parseImdbId(pageHtml);
        const links = surface.parseDownloadLinks(pageHtml, workUrl.href);
        const type = season ? 'series' as const : 'movie' as const;
        if (!links.length) {
          return { url, status: 'no-torrent', imdb, title, year, type, requestCost: counter.n };
        }
        const maxButtons = Math.max(1, Math.trunc(Number(pageOpts?.series?.maxButtons ?? config.crawl.seriesMaxButtons) || config.crawl.seriesMaxButtons));
        const announced = links.length;
        const planned = season ? links.slice(0, maxButtons) : links;
        if (planned.length < announced) {
          log.warn(`[crawl] comandotorrents: ${announced} botão(ões) na página de temporada, seguindo ${planned.length} (teto de série)`);
        }
        const releases: RawItem[] = [];
        const seen = new Set<string>();
        let followed = 0;
        let lastError: unknown = null;
        let terminalFails = 0;
        let otherFails = 0;
        for (const link of planned) {
          try {
            const finalHtml = await surface.fetchFollowingAllowed(link.url, workUrl.href, { onRequest: countRequest });
            followed += 1;
            const magnet = surface.extractMagnet(finalHtml);
            if (!magnet) continue;
            const hash = magnetHash(magnet);
            if (hash && seen.has(hash)) continue;
            if (hash) seen.add(hash);
            releases.push(releaseToRawItem(surface, { title, year }, link, magnet));
          } catch (err) {
            lastError = err;
            if (isTerminalButtonError(err)) terminalFails += 1;
            else otherFails += 1;
            log.warn(`[crawl] comandotorrents: botão falhou (${url}):`, log.errorMessage(err));
          }
        }
        if (!releases.length) {
          if (terminalFails === planned.length && otherFails === 0 && followed === 0) {
            return { url, status: 'no-torrent', imdb, title, year, type, requestCost: counter.n };
          }
          if (!followed && lastError) throw lastError;
          const failed = planned.length - followed;
          const detail = lastError ? `; último erro: ${log.errorMessage(lastError)}` : '';
          throw new Error(
            `comandotorrents: ${planned.length} botão(ões) anunciados, nenhum magnet `
            + `(${followed} sem magnet, ${failed} com falha)${detail}`,
          );
        }
        // A ficha declara o título original: 2º nome da identificação (quando o `<h1>` não casa).
        const originalTitle = parseOriginalTitle(pageHtml);
        if (season) {
          // Série: temporada do post (`<h1>` cru, senão o slug) e grupos por locação.
          const h1 = h1Text(pageHtml);
          const pageSeason = pageSeasonOf(h1, workUrl.href);
          const sample: ComandotorrentsSeasonSample = {
            url, status: 'done', imdb, title, year, originalTitle, season: pageSeason, type, releases,
            groups: seasonPageGroups(releases, { season: pageSeason, title: h1 }),
            requestCost: counter.n, buttons: announced, buttonsFollowed: followed,
          };
          return sample;
        }
        return { url, status: 'done', imdb, title, year, originalTitle, type, releases, requestCost: counter.n };
      } catch (err) {
        throw withRequestCost(err, counter.n);
      }
    },
  };
}

/**
 * Instância de produção. O registry chama este export sem argumentos, e ele
 * NUNCA liga `seriesProbe`: a temporada entra pela opção de séries do painel.
 */
export function comandotorrentsCrawlSite(): CrawlSite {
  const surface = instance(RESOLVER_NAME) as ComandotorrentsResolverSurface | null;
  if (!surface || typeof surface.fetchTextDirect !== 'function') {
    throw new Error('comandotorrents: resolvedor embutido não carregado — raspagem indisponível');
  }
  return createComandotorrentsCrawlSite(surface);
}
