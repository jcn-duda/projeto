// Adaptador de raspagem do Vaca Torrent (plano "Raspagem total", Fase 1 —
// somente LEITURA). O motor (fase 3) cuida de fila, ritmo e gravação; aqui só
// existem as duas respostas do contrato `CrawlSite`:
//
//   discover()   → sitemap_index.xml do domínio ATIVO do resolver, entradas
//                  `movie-sitemap*.xml` (Yoast), com lastmod e tipo `movie`;
//   fetchWork()  → página da obra → página `movie-links/<n>` → magnets, tudo
//                  pelo resolver JÁ CARREGADO (`br-resolvers.instance`), que
//                  aporta domínio vivo, Cloudflare/FlareSolverr, protetores e
//                  extração de magnet.
//
// Nada aqui grava banco, agenda nada nem liga o crawler: a Fase 1 entrega o
// adaptador puro e os testes com fixtures reais (fetch dublê, sem rede).
import type { RawItem } from '../../../types/domain.js';
import type { ResolverLink } from '../../../resolvers/types.js';
import type { ReleaseTitleInput, ReleaseTitlePost } from '../../../resolvers/release-format.js';
import type { CrawlSite, CrawlWorkResult, DiscoveredUrl } from '../crawl-types.js';
import { instance } from '../../br-resolvers.js';
import * as log from '../../utils/logger.js';

/**
 * Recorte da instância do profile vacatorrent que o adaptador consome. Declarar
 * a superfície aqui (em vez de `any`) faz o compilador cobrar os métodos que o
 * adaptador usa contra a API REAL do profile — quebra em compilação se o
 * profile renomear algo.
 */
export interface VacaResolverSurface {
  siteSelector: { url(): string };
  assertAllowedUrl(value: string | null | undefined): URL;
  fetchText(url: string, accept?: string): Promise<string>;
  extractMovieLinks(html: string | null | undefined, baseUrl?: string): string | null;
  parseDownloadLinks(html: string | null | undefined, baseUrl?: string, options?: Record<string, unknown>): ResolverLink[];
  fetchFollowingAllowed(value: string, referer?: string | null): Promise<string>;
  extractMagnet(html: string | null | undefined): string | null;
  releaseTitle(post: ReleaseTitlePost, link: ReleaseTitleInput, index?: number | null): string;
  parseSize(text: string | null | undefined): number | null;
}

/** id do card do Jackett (dedupe, `ji`/`jl` e prioridade por site). */
const SITE_ID = 'vacatorrent';
const TRACKER_LABEL = 'Vaca Torrent';
/** Sitemaps de filmes do índice Yoast: `movie-sitemap.xml`, `movie-sitemap2.xml`… */
const MOVIE_SITEMAP_RE = /\/movie-sitemap\d*\.xml$/i;
/** Entrada de obra: `/pt/movie/<slug>/` (o acervo `/movie/` sem slug fica fora). */
const MOVIE_WORK_RE = /\/(?:pt\/)?movie\/[^/]+\/$/i;
const SITEMAP_LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/i;
const SITEMAP_LASTMOD_RE = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i;

/** Bloco de URL do sitemap (ou bloco de sitemap do índice) em pares loc/lastmod. */
function parseSitemapEntries(xml: string): { loc: string; lastmod: string }[] {
  const out: { loc: string; lastmod: string }[] = [];
  const blocks = String(xml || '').match(/<(?:url|sitemap)>[\s\S]*?<\/(?:url|sitemap)>/gi) ?? [];
  for (const block of blocks) {
    const loc = SITEMAP_LOC_RE.exec(block)?.[1]?.trim();
    if (!loc) continue;
    const lastmod = SITEMAP_LASTMOD_RE.exec(block)?.[1]?.trim() || '';
    out.push({ loc, lastmod });
  }
  return out;
}

/** Título e ano do `<h1>` da obra ("Expresso do Amanhã (2013)"). */
function parseTitleYear(html: string): { title: string; year: number | null } {
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(String(html || ''))?.[1] ?? '';
  const text = h1.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const yearMatch = /\((\d{4})\)\s*$/.exec(text);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const title = (yearMatch ? text.slice(0, yearMatch.index) : text).replace(/\s+/g, ' ').trim();
  return { title, year: year && year >= 1900 && year <= 2100 ? year : null };
}

/** IMDb da página: o link "Avaliação da IMDb" aponta para /title/tt<id>/. */
function parseImdbId(html: string): string | null {
  return /imdb\.com\/title\/(tt\d{5,})/i.exec(String(html || ''))?.[1] ?? null;
}

/** Dedupe por btih do magnet: o mesmo hash duas vezes na página é um só item. */
function magnetHash(magnet: string): string | null {
  return /xt=urn:btih:([a-z0-9]{32,40})/i.exec(magnet)?.[1]?.toLowerCase() ?? null;
}

/** Botão resolvido → item cru no MESMO formato da busca (RawItem). */
function releaseToRawItem(
  surface: VacaResolverSurface,
  obra: { title: string; year: number | null },
  link: ResolverLink,
  magnet: string,
): RawItem {
  return {
    // O título da release segue a MESMA régua do card no Jackett (ano,
    // DUBLADO/DUAL, qualidade e tamanho do botão real).
    title: surface.releaseTitle({ title: obra.title, year: obra.year }, link),
    magnet,
    indexer: SITE_ID,
    tracker: TRACKER_LABEL,
    // Invariante 2: a origem BR é campo do provider — indexers BR carimbam
    // `isBr` independentemente do título.
    isBr: true,
    // Invariante 3: fontes BR não publicam swarm; 1 é o valor neutro que
    // sobrevive ao MIN_SEEDERS.
    seeders: 1,
    size: surface.parseSize(link.size) ?? undefined,
  };
}

/**
 * Fábrica PURA do adaptador: recebe a superfície do resolver pronta (nos
 * testes, a instância real do profile com fetch dublê). Nenhuma rede acontece
 * fora dos dois métodos do contrato.
 */
export function createVacaCrawlSite(surface: VacaResolverSurface): CrawlSite {
  /** Um sitemap do índice: baixa e devolve as obras (slug + lastmod). */
  async function readMovieSitemap(loc: string, since: string | null): Promise<DiscoveredUrl[]> {
    const xml = await surface.fetchText(loc);
    const out: DiscoveredUrl[] = [];
    for (const entry of parseSitemapEntries(xml)) {
      let path: string;
      try { path = new URL(entry.loc).pathname; } catch { continue; }
      if (!MOVIE_WORK_RE.test(path)) continue; // acervo `/movie/` e páginas estranhas
      // Incremental: lastmod ≤ since já foi processado (upsert do store é
      // idempotente, então o filtro é economia, não correção). Lastmod
      // ilegível entra — não se perde obra por ruído de data.
      if (since) {
        const t = Date.parse(entry.lastmod);
        const floor = Date.parse(since);
        if (Number.isFinite(t) && Number.isFinite(floor) && t <= floor) continue;
      }
      out.push({ url: entry.loc, lastmod: entry.lastmod, kind: 'movie' });
    }
    return out;
  }

  return {
    id: SITE_ID,
    label: TRACKER_LABEL,

    async discover(since?: string | null): Promise<DiscoveredUrl[]> {
      const base = surface.siteSelector.url();
      const indexUrl = new URL('sitemap_index.xml', base).href;
      const indexXml = await surface.fetchText(indexUrl);
      const sitemaps = parseSitemapEntries(indexXml)
        .map((entry) => {
          try { return new URL(entry.loc, base).href; } catch { return null; }
        })
        .filter((href): href is string => !!href && MOVIE_SITEMAP_RE.test(new URL(href).pathname));
      if (!sitemaps.length) throw new Error('vacatorrent: nenhum movie-sitemap no índice');
      // Sequencial (constraint crawl.search_isolation): um pedido por vez, sem
      // rajada no site nem no FlareSolverr. Sitemap que falha não derruba a
      // descoberta — só uma rodada toda falha é erro para o motor retentar.
      const out: DiscoveredUrl[] = [];
      let ok = 0;
      for (const loc of sitemaps) {
        try {
          out.push(...await readMovieSitemap(loc, since || null));
          ok += 1;
        } catch (err) {
          log.warn(`[crawl] vacatorrent: sitemap falhou (${loc}):`, log.errorMessage(err));
        }
      }
      if (!ok) throw new Error('vacatorrent: todos os movie-sitemap falharam');
      return out;
    },

    async fetchWork(url: string): Promise<CrawlWorkResult> {
      // Defesa em profundidade: a fila nasce da nossa descoberta, mas o store
      // pode ter sido editado — host de fora do site é rejeitado na porta.
      surface.assertAllowedUrl(url);
      const pageHtml = await surface.fetchText(url);
      const { title, year } = parseTitleYear(pageHtml);
      if (!title) {
        // Página sem título é quebra de layout, não obra sem nome: erro para o
        // backoff do motor (e canário do painel), nunca release inventada.
        return { url, status: 'error', error: 'layout: página sem <h1> de título' };
      }
      const imdb = parseImdbId(pageHtml);
      const linksUrl = surface.extractMovieLinks(pageHtml, url);
      if (!linksUrl) {
        // Página só de streaming (ou recém-criada, sem botões): sem magnet.
        return { url, status: 'no-torrent', imdb, title, year, type: 'movie' };
      }
      const linksHtml = await surface.fetchText(linksUrl);
      const links = surface.parseDownloadLinks(linksHtml, linksUrl);
      if (!links.length) {
        // A página movie-links existe mas só tem "Assistir" (players não são
        // âncora de protetor, o coletor os ignora): sem torrent publicado.
        return { url, status: 'no-torrent', imdb, title, year, type: 'movie' };
      }

      // Protetor → magnet, UM botão por vez, na ordem da página. Falha de um
      // botão não perde os demais; TODOS falharem é erro da página (o motor
      // retenta com backoff) — página com botões que ninguém resolveu não vira
      // `no-torrent`, que mentiria "não tem torrent".
      const obra = { title, year };
      const releases: RawItem[] = [];
      const seen = new Set<string>();
      let followed = 0;
      let lastError: unknown = null;
      for (const link of links) {
        try {
          const finalHtml = await surface.fetchFollowingAllowed(link.url, url);
          followed += 1;
          const magnet = surface.extractMagnet(finalHtml);
          if (!magnet) continue; // cadeia resolveu mas não há magnet: não inventa
          const hash = magnetHash(magnet);
          if (hash && seen.has(hash)) continue; // mesmo hash, botão repetido
          if (hash) seen.add(hash);
          releases.push(releaseToRawItem(surface, obra, link, magnet));
        } catch (err) {
          lastError = err;
          log.warn(`[crawl] vacatorrent: botão falhou (${url}):`, log.errorMessage(err));
        }
      }
      if (!followed && lastError) throw lastError;
      return { url, status: 'done', imdb, title, year, type: 'movie', releases };
    },
  };
}

/**
 * Instância de produção: reusa o resolver vacatorrent JÁ CARREGADO no processo
 * (mesma sessão FlareSolverr, mesmo seletor de domínio, mesmos caches). Sem o
 * resolver embutido não há raspagem — erro claro, sem criar instância nova.
 */
export function vacaCrawlSite(): CrawlSite {
  const surface = instance(SITE_ID) as VacaResolverSurface | null;
  if (!surface || typeof surface.fetchText !== 'function') {
    throw new Error('vacatorrent: resolvedor embutido não carregado — raspagem indisponível');
  }
  return createVacaCrawlSite(surface);
}
