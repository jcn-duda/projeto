// Adaptador de raspagem do Vaca Torrent (plano "Raspagem total", Fase 1 —
// somente LEITURA). O motor (fase 3) cuida de fila, ritmo e gravação; aqui só
// existem as duas respostas do contrato `CrawlSite`:
//
//   discover()   → sitemap_index.xml do domínio ATIVO do resolver, entradas
//                  `movie-sitemap*.xml` (Yoast), com lastmod e tipo `movie`;
//                  falha de sitemap NÃO derruba a rodada — vem como descoberta
//                  parcial (`complete:false` + `failures`) para o motor não
//                  avançar o cursor incremental por cima de pedaço perdido;
//   fetchWork()  → página da obra → página `movie-links/<n>` → magnets, tudo
//                  pelo resolver JÁ CARREGADO (`br-resolvers.instance`), que
//                  aporta domínio vivo, protetores e extração de magnet.
//
// Travas da revisão da Fase 1 (não negociáveis):
//   - Host safety em TODA URL derivada de conteúdo do site (loc do índice,
//     URL de obra, movie-links): só hostname candidato do site serve como
//     página; protetor fica por conta do transporte. Sitemap adulterado não
//     vira vetor de SSRF — o motor busca o que a fila guardar.
//   - Crawl NÃO aciona FlareSolverr: o fetch é o caminho DIRETO do perfil
//     (`fetchTextDirect`), que reusa passivamente a sessão quente e devolve
//     ERRO no desafio (gatilho de pausa futuro). A busca ao vivo segue com o
//     fallback dela, intacta.
//   - IMDb só ancorado na ficha técnica da página; ambíguo → null (obra
//     errada é pior que obra nenhuma).
//
// Nada aqui grava banco, agenda nada nem liga o crawler: a Fase 1 entrega o
// adaptador puro e os testes com fixtures reais (fetch dublê, sem rede).
import type { RawItem } from '../../../types/domain.js';
import type { ResolverLink } from '../../../resolvers/types.js';
import type { ReleaseTitleInput, ReleaseTitlePost } from '../../../resolvers/release-format.js';
import type { CrawlDiscovery, CrawlSite, CrawlWorkResult, DiscoveredUrl } from '../crawl-types.js';
import { instance } from '../../br-resolvers.js';
import * as log from '../../utils/logger.js';
import { decodeEntities } from '../../utils/title-normalization.js';

/**
 * Recorte da instância do profile vacatorrent que o adaptador consome. Declarar
 * a superfície aqui (em vez de `any`) faz o compilador cobrar os métodos que o
 * adaptador usa contra a API REAL do profile — quebra em compilação se o
 * profile renomear algo. O `fetchText` com fallback Flare fica FORA do recorte
 * de propósito: o crawl não tem como acioná-lo sem trocar o contrato.
 */
export interface VacaResolverSurface {
  siteSelector: { url(): string };
  assertAllowedUrl(value: string | null | undefined): URL;
  /** Host candidato do SITE (allowlist do failover) — páginas só dele. */
  isDetailHost(hostname: string | null | undefined): boolean;
  /** Fetch direto do perfil, SEM fallback FlareSolverr (desafio = erro). */
  fetchTextDirect(url: string, accept?: string): Promise<string>;
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
/** IMDb: âncora da FICHA TÉCNICA da página ("Avaliação da IMDb: <a …>").
 * A janela curta depois do rótulo impede que o match cruze para um link de
 * recomendação vizinho — pegar "o primeiro imdb.com do HTML" devolvia o tt de
 * OUTRA obra (widgets de relacionados linkam filmes alheios). */
const IMDB_ANCHOR_RE = /Avalia[^<]{0,16}IMDb[\s\S]{0,120}?imdb\.com\/title\/(tt\d{5,})/gi;

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

/** Título e ano do `<h1>` da obra ("Expresso do Amanhã (2013)"). Exportado
 * para a sonda da Fase 2 (`scripts/crawl-identify-probe`) classificar página
 * com a MESMA régua do adaptador — duplicar o parser divergiria em silêncio. */
export function parseTitleYear(html: string): { title: string; year: number | null } {
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(String(html || ''))?.[1] ?? '';
  // WordPress devolve o título com entidade crua ("A Gangster&#8217;s Life",
  // "Mike &#038; Nick"): decodificar ANTES de tudo. A query do TMDB da Fase 2
  // não encontra a obra com "&#8217;" no meio e o título herdado pelas
  // releases carregaria o lixo — medido ao vivo na sonda da Fase 2: 2 de 30
  // páginas sem IMDb perdiam a identificação só por isso.
  const text = decodeEntities(h1.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const yearMatch = /\((\d{4})\)\s*$/.exec(text);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const title = (yearMatch ? text.slice(0, yearMatch.index) : text).replace(/\s+/g, ' ').trim();
  return { title, year: year && year >= 1900 && year <= 2100 ? year : null };
}

/**
 * IMDb da OBRA, pelo âncora da ficha técnica. Um tt ancorado é o da página;
 * dois ancorados distintos é página ambígua e SEM âncora nenhum tt entra —
 * um link solto pode ser de recomendação, e obra errada é pior que obra
 * nenhuma (a identificação por título/ano é fase 2, nunca IMDb alheio).
 * Exportado para a sonda da Fase 2 (`scripts/crawl-identify-probe`) separar
 * página "com IMDb" de "sem IMDb" com a MESMA régua do adaptador.
 */
export function parseImdbId(html: string): string | null {
  const anchored = new Set(
    [...String(html || '').matchAll(IMDB_ANCHOR_RE)].map((m) => m[1]),
  );
  return anchored.size === 1 ? [...anchored][0] : null;
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
  /**
   * Página do SITE (host safety): loc de sitemap, URL de obra e movie-links
   * derivam de conteúdo do site — só hostname candidato serve. O detalhe do
   * host vai no erro (diagnóstico do painel); o assert canônico do resolver
   * fica como segunda camada (protocolo + allowlist completa).
   */
  function assertSiteUrl(value: string): URL {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error('invalid_url'); }
    if (!surface.isDetailHost(parsed.hostname)) {
      throw new Error(`blocked_host:${parsed.hostname.toLowerCase()}`);
    }
    return surface.assertAllowedUrl(value);
  }

  /** Um sitemap do índice: baixa e devolve as obras (slug + lastmod). */
  async function readMovieSitemap(loc: string, since: string | null): Promise<DiscoveredUrl[]> {
    const xml = await surface.fetchTextDirect(loc);
    const out: DiscoveredUrl[] = [];
    for (const entry of parseSitemapEntries(xml)) {
      // URL de obra é INPUT do site: resolve relativa, exige forma de obra E
      // host do site — sitemap adulterado não planta URL alheia na fila.
      let href: URL;
      try { href = new URL(entry.loc, loc); } catch { continue; }
      if (!MOVIE_WORK_RE.test(href.pathname)) continue; // acervo `/movie/` e páginas estranhas
      if (!surface.isDetailHost(href.hostname)) continue;
      // Incremental: lastmod ≤ since já foi processado (upsert do store é
      // idempotente, então o filtro é economia, não correção). Lastmod
      // ilegível entra — não se perde obra por ruído de data.
      if (since) {
        const t = Date.parse(entry.lastmod);
        const floor = Date.parse(since);
        if (Number.isFinite(t) && Number.isFinite(floor) && t <= floor) continue;
      }
      out.push({ url: href.href, lastmod: entry.lastmod, kind: 'movie' });
    }
    return out;
  }

  return {
    id: SITE_ID,
    label: TRACKER_LABEL,

    async discover(since?: string | null): Promise<CrawlDiscovery> {
      const base = surface.siteSelector.url();
      const indexUrl = new URL('sitemap_index.xml', base).href;
      const indexXml = await surface.fetchTextDirect(indexUrl);
      const sitemaps: string[] = [];
      for (const entry of parseSitemapEntries(indexXml)) {
        let href: URL;
        try { href = new URL(entry.loc, base); } catch { continue; }
        if (!MOVIE_SITEMAP_RE.test(href.pathname)) continue;
        // Loc do índice é input do site: host de fora NEM É CONSULTADO.
        try { assertSiteUrl(href.href); } catch { continue; }
        sitemaps.push(href.href);
      }
      if (!sitemaps.length) throw new Error('vacatorrent: nenhum movie-sitemap no índice');
      // Sequencial (constraint crawl.search_isolation): um pedido por vez, no
      // caminho direto (sem FlareSolverr). Sitemap que falha não derruba a
      // rodada — vira descoberta PARCIAL (`complete:false`): as URLs colhidas
      // seguem válidas, mas o motor não pode avançar o cursor incremental
      // por cima do lastmod que ficou no sitemap perdido. Só uma rodada TODA
      // falha é erro para o motor retentar.
      const out: DiscoveredUrl[] = [];
      const failures: string[] = [];
      for (const loc of sitemaps) {
        try {
          out.push(...await readMovieSitemap(loc, since || null));
        } catch (err) {
          failures.push(`${loc}: ${log.errorMessage(err)}`);
          log.warn(`[crawl] vacatorrent: sitemap falhou (${loc}):`, log.errorMessage(err));
        }
      }
      if (sitemaps.length && !out.length && failures.length === sitemaps.length) {
        throw new Error('vacatorrent: todos os movie-sitemap falharam');
      }
      return { urls: out, complete: failures.length === 0, failures };
    },

    async fetchWork(url: string): Promise<CrawlWorkResult> {
      // Defesa em profundidade: a fila nasce da nossa descoberta, mas o store
      // pode ter sido editado — host de fora do site (e protetor como página)
      // é rejeitado na porta, antes de qualquer fetch.
      const workUrl = assertSiteUrl(url);
      const pageHtml = await surface.fetchTextDirect(workUrl.href);
      const { title, year } = parseTitleYear(pageHtml);
      if (!title) {
        // Página sem título é quebra de layout, não obra sem nome: erro para o
        // backoff do motor (e canário do painel), nunca release inventada.
        return { url, status: 'error', error: 'layout: página sem <h1> de título' };
      }
      const imdb = parseImdbId(pageHtml);
      const linksUrl = surface.extractMovieLinks(pageHtml, workUrl.href);
      if (!linksUrl) {
        // Página só de streaming (ou recém-criada, sem botões): sem magnet.
        return { url, status: 'no-torrent', imdb, title, year, type: 'movie' };
      }
      // movie-links também é página do site: href adulterado para host de fora
      // é erro diagnosticável, nunca `no-torrent` (que mentiria sobre o acervo).
      const linksChecked = assertSiteUrl(linksUrl);
      const linksHtml = await surface.fetchTextDirect(linksChecked.href);
      const links = surface.parseDownloadLinks(linksHtml, linksChecked.href);
      if (!links.length) {
        // A página movie-links existe mas só tem "Assistir" (players não são
        // âncora de protetor, o coletor os ignora): sem torrent publicado.
        return { url, status: 'no-torrent', imdb, title, year, type: 'movie' };
      }

      // Protetor → magnet, UM botão por vez, na ordem da página. Falha de um
      // botão não perde os demais — botão individual falho é tolerado quando
      // outro rende release. TODOS terminais — `protector_link_expired` (HTTP
      // 400 + "Link inválido ou expirado") ou `protector_non_magnet` (gate-2
      // com download direto, ex.: Google Drive) — → `no-torrent` na 1ª
      // tentativa, sem retry: não há torrent a colher. Mistura com
      // rede/timeout continua retentável. Demais falhas totais (layout/protetor
      // sem magnet) seguem erro.
      const obra = { title, year };
      const releases: RawItem[] = [];
      const seen = new Set<string>();
      let followed = 0;
      let lastError: unknown = null;
      let terminalFails = 0;
      let otherFails = 0;
      const isTerminal = (err: unknown) => /protector_(?:link_expired|non_magnet)/i.test(
        err instanceof Error ? err.message : String(err),
      );
      for (const link of links) {
        try {
          if (!/^magnet:/i.test(link.url)) surface.assertAllowedUrl(link.url);
          const finalHtml = await surface.fetchFollowingAllowed(link.url, workUrl.href);
          followed += 1;
          const magnet = surface.extractMagnet(finalHtml);
          if (!magnet) continue; // cadeia resolveu mas não há magnet: não inventa
          const hash = magnetHash(magnet);
          if (hash && seen.has(hash)) continue; // mesmo hash, botão repetido
          if (hash) seen.add(hash);
          releases.push(releaseToRawItem(surface, obra, link, magnet));
        } catch (err) {
          lastError = err;
          if (isTerminal(err)) terminalFails += 1;
          else otherFails += 1;
          log.warn(`[crawl] vacatorrent: botão falhou (${url}):`, log.errorMessage(err));
        }
      }
      if (!releases.length) {
        // Todos os botões terminais (expirado/download direto) → sem torrent.
        if (terminalFails === links.length && otherFails === 0 && followed === 0) {
          return { url, status: 'no-torrent', imdb, title, year, type: 'movie' };
        }
        // Nenhuma cadeia foi adiante: o erro real do transporte é a causa e
        // segue como está. Caso contrário, cadeias resolveram e nenhum magnet
        // veio — o motivo conta os dois lados (sem magnet × com falha) e cita
        // o último erro de botão, para o painel separar layout de rede.
        if (!followed && lastError) throw lastError;
        const failed = links.length - followed;
        const detail = lastError ? `; último erro: ${log.errorMessage(lastError)}` : '';
        throw new Error(
          `vacatorrent: ${links.length} botão(ões) anunciados, nenhum magnet `
          + `(${followed} sem magnet, ${failed} com falha)${detail}`,
        );
      }
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
  if (!surface || typeof surface.fetchTextDirect !== 'function') {
    throw new Error('vacatorrent: resolvedor embutido não carregado — raspagem indisponível');
  }
  return createVacaCrawlSite(surface);
}
