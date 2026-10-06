// Adaptador de raspagem do NerdFilmes / XNerdFilmes (Fase 8 — segundo site do
// motor multi-site). O motor cuida de fila, ritmo e gravação; aqui só existem
// as duas respostas do contrato `CrawlSite`: `discover()` (índice de sitemaps →
// `post-sitemap*.xml` → obras com lastmod e TIPO pelo slug) e `fetchWork()`
// (post → botões `/link.php?id=<blob>` → magnet), sempre pelo resolver JÁ
// CARREGADO (`br-resolvers.instance`). As regras puras de sitemap, slug e IMDb
// foram para `nerdfilmes-discovery.ts` (a catraca de 400 linhas); aqui mora o
// que faz REDE.
//
// PORTÃO DE SÉRIE. O `post-sitemap` é misto (13 de 40 páginas do recorte real
// são de TEMPORADA) e o `kind` sai do slug. A página de temporada entra no motor
// com a opção de SÉRIES ligada (`opts.series.enabled`, a mesma do Vaca) ou no
// modo amostra (`seriesProbe`); sem nenhuma das duas, `discover()` não a emite e
// `fetchWork(kind:'tv_show')` é erro com zero rede. Cada botão nasce na locação
// que o `dn`/rótulo declara (`season-page.ts`), nunca tudo na raiz, e a página
// de temporada chegada como `movie` continua recusada: episódio gravado como
// filme é obra errada.
//
// Travas herdadas do crawler: host safety em TODA URL derivada de conteúdo do
// site (loc do índice, loc do sitemap, URL de obra) — o gate/protetor é por conta
// do transporte, e o `/link.php` é de MESMO ORIGIN (o host não o pega), então a
// segunda trava dele é a FORMA da URL; crawl NÃO aciona FlareSolverr (o
// `fetchTextDirect` do perfil já é o caminho direto, e o `onRequest` dele conta o
// custo real por hop); descoberta PARCIAL não derruba a rodada (sitemap que falha
// vira `failures` + `complete:false` e o cursor não anda); erro carrega o custo
// medido (F1, `withRequestCost`).
// Nada aqui grava banco, agenda nada nem liga o crawler.
import config from '../../config.js';
import type { RawItem } from '../../../types/domain.js';
import type { ResolverLink } from '../../../resolvers/types.js';
import type { ReleaseTitleInput, ReleaseTitlePost } from '../../../resolvers/release-format.js';
import type {
  CrawlDiscovery, CrawlPageKind, CrawlPageOptions, CrawlSite, CrawlWorkResult, CrawlDiscoverOptions, DiscoveredUrl,
} from '../crawl-types.js';
import { instance } from '../../br-resolvers.js';
import * as log from '../../utils/logger.js';
import { magnetHash, parseOriginalTitle, parseTitleYear, withRequestCost } from './shared.js';
import { pageSeasonOf, seasonPageGroups } from './season-page.js';
import { cleanWorkName } from './work-name.js';
import { assertSitemapScope } from './sitemap-guard.js';
import {
  isSeasonSlug, isWorkPath, kindFromSlug, parseImdbId, parseSitemapEntries,
  parseSitemapIndexLocs, SITEMAP_INDEX_PATHS, toWorkUrl,
} from './nerdfilmes-discovery.js';

/**
 * Recorte da instância do profile nerdfilmes que o adaptador consome. Declarar
 * a superfície aqui (em vez de `any`) faz o compilador cobrar os métodos contra
 * a API REAL do profile — quebra em compilação se o profile renomear algo.
 */
export interface NerdfilmesResolverSurface {
  siteSelector: { url(): string };
  assertAllowedUrl(value: string | null | undefined): URL;
  /** Host candidato do SITE (allowlist do failover) — páginas só dele. */
  isDetailHost(hostname: string | null | undefined): boolean;
  /** Fetch direto do perfil, com contagem por HOP (F3) para o custo do motor. */
  fetchTextDirect(url: string, accept?: string, hooks?: { onRequest?: () => void }): Promise<string>;
  parseDownloadLinks(html: string | null | undefined, baseUrl?: string): ResolverLink[];
  fetchFollowingAllowed(value: string, referer?: string | null, hooks?: { onRequest?: () => void }): Promise<string>;
  extractMagnet(html: string | null | undefined): string | null;
  releaseTitle(post: ReleaseTitlePost, link: ReleaseTitleInput, index?: number | null): string;
  parseSize(text: string | null | undefined): number | null;
}

/**
 * Opções PRÓPRIAS do adaptador. `seriesProbe` é o MODO AMOSTRA: a única
 * passagem autorizada para `kind:'tv_show'`, e ela existe para a sonda da Fase 8
 * (medir o que uma página de temporada devolve) — nunca para o motor. Mora
 * aqui, e não em `CrawlPageOptions`, porque aquele é o contrato COMPARTILHADO de
 * todos os sites. `fetchWork` também aceita a mesma flag por chamada (ver
 * `probeRequested`), para quem só tem a interface `CrawlSite` em mãos.
 */
export interface NerdfilmesCrawlOptions {
  seriesProbe?: boolean;
}

/**
 * Resultado da AMOSTRA de temporada. O contrato compartilhado não tem campo
 * para "quantos botões a página anunciava" — e é o denominador que a sonda
 * precisa para separar "página com botão" de "página com magnet". Quem só
 * enxerga `CrawlWorkResult` continua com o contrato base, sem campo novo nele.
 */
export interface NerdfilmesSeasonSample extends CrawlWorkResult {
  /** Botões de torrent anunciados na página (o denominador). */
  buttons: number;
  /** Botões que o transporte chegou a seguir (o outro lado da régua). */
  buttonsFollowed: number;
}

/** id do card do Jackett (dedupe, `ji`/`jl`, reserva por indexer falho). */
const SITE_ID = 'nerdfilmes';
const TRACKER_LABEL = 'NerdFilmes';

// `seriesProbe` por CHAMADA: o `CrawlPageOptions` compartilhado não tem o campo
// e não é meu para mudar — cast concentrado aqui, leitura por `=== true`.
function probeRequested(pageOpts?: CrawlPageOptions): boolean {
  return (pageOpts as { seriesProbe?: unknown } | undefined)?.seriesProbe === true;
}

/**
 * Botão `/link.php` sem torrent a colher — TERMINAL, não retentável. O site
 * responde HTTP 400 "Payload inválido." para um blob que ele não decodifica
 * (medido 2026-09-28), e o MESMO blob respondeu 200 duas vezes no mesmo minuto:
 * repetir devolve o mesmo 400 para sempre. Só vale para o gate de MESMO ORIGIN
 * do site (400 de protetor externo é `http_400` e segue retentável).
 */
function isTerminalButtonError(err: unknown, linkUrl: string, workUrl: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/protector_(?:link_expired|non_magnet)/i.test(message)) return true;
  if (!/^http_400$/.test(message)) return false;
  try {
    const link = new URL(linkUrl);
    return link.origin === new URL(workUrl).origin && link.pathname.toLowerCase() === '/link.php';
  } catch {
    return false;
  }
}

/** Botão resolvido → item cru no MESMO formato da busca (RawItem). */
function releaseToRawItem(
  surface: NerdfilmesResolverSurface,
  obra: { title: string; year: number | null },
  link: ResolverLink,
  magnet: string,
): RawItem {
  return {
    // Título no MESMO formato do card no Jackett (qualidade, DUBLADO/DUAL e
    // tamanho do botão real). Na temporada o botão traz `Ep 01` e o título sai
    // com `E01`: é a EVIDÊNCIA de que o site publica por episódio.
    title: surface.releaseTitle({ title: obra.title, year: obra.year }, link),
    magnet,
    indexer: SITE_ID,
    tracker: TRACKER_LABEL,
    // Invariante 2: a origem BR é campo do provider. Invariante 3: fonte BR
    // não publica swarm, e 1 é o valor neutro que sobrevive ao MIN_SEEDERS.
    isBr: true,
    seeders: 1,
    size: surface.parseSize(link.size) ?? undefined,
  };
}

/**
 * Fábrica do adaptador: recebe a superfície do resolver pronta (nos testes, a
 * instância real do profile com fetch dublê).
 */
export function createNerdfilmesCrawlSite(
  surface: NerdfilmesResolverSurface,
  options: NerdfilmesCrawlOptions = {},
): CrawlSite {
  const seriesProbe = options.seriesProbe === true;

  /**
   * Página do SITE (host safety): loc de sitemap, loc de obra e URL de página
   * derivam de conteúdo do site — só hostname candidato serve. O host rejeitado
   * viaja no erro (diagnóstico do painel); o assert do resolver é a 2ª camada.
   */
  function assertSiteUrl(value: string): URL {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error('invalid_url'); }
    if (!surface.isDetailHost(parsed.hostname)) {
      throw new Error(`blocked_host:${parsed.hostname.toLowerCase()}`);
    }
    return surface.assertAllowedUrl(value);
  }

  /** Índice de sitemaps: o canônico e, se não servir, o caminho Yoast (302). */
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
    throw new Error(`nerdfilmes: índice de sitemaps ilegível (${failures.join(' | ')})`);
  }

  /**
   * Um `post-sitemap*.xml`: as obras (slug + lastmod + kind). O corte
   * incremental é POR KIND (`sinceOf`) — o sitemap é único, mas os cursores de
   * filme e de série andam separados e um não pode cortar o outro.
   */
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
      if (!href) continue; // listagem, imagem do post, página estranha
      accepted += 1;
      const kind = kindFromSlug(href);
      // Incremental: lastmod ≤ since já foi processado (upsert do store é
      // idempotente, então o filtro é economia, não correção). Lastmod
      // ilegível entra — não se perde obra por ruído de data.
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
      // Séries ligadas (ou amostra) emitem `tv_show`. Sem isso a lista é de
      // filmes e o cursor de série não anda (sem URL do kind não há `max`).
      const emitSeries = seriesProbe || opts?.series?.enabled === true;
      const sinceByKind = opts?.sinceByKind;
      const sinceOf = (kind: CrawlPageKind): string | null => (
        sinceByKind && Object.prototype.hasOwnProperty.call(sinceByKind, kind)
          ? (sinceByKind[kind] ?? null)
          : (since ?? null)
      );
      // Custo REAL da rodada (F3, por hop): índice + um fetch por post-sitemap.
      // Sem isto a descoberta entraria de graça no teto por hora, que é de
      // requisições (o motor aceita `CrawlDiscovery.requestCost`).
      const counter = { n: 0 };
      const countRequest = () => { counter.n += 1; };
      const base = surface.siteSelector.url();
      const indexXml = await readSitemapIndex(countRequest);
      const sitemaps = parseSitemapIndexLocs(indexXml, base, (h) => surface.isDetailHost(h));
      if (!sitemaps.length) throw new Error('nerdfilmes: nenhum post-sitemap no índice');
      // Sequencial (constraint crawl.search_isolation): um pedido por vez, no
      // caminho direto. Sitemap que falha não derruba a rodada — vira descoberta
      // PARCIAL, e o cursor não avança por cima do que ficou nos arquivos perdidos.
      const all: DiscoveredUrl[] = [];
      const failures: string[] = [];
      for (const loc of sitemaps) {
        try {
          all.push(...await readWorkSitemap(loc, sinceOf, countRequest));
        } catch (err) {
          failures.push(`${loc}: ${log.errorMessage(err)}`);
          log.warn(`[crawl] nerdfilmes: sitemap falhou (${loc}):`, log.errorMessage(err));
        }
      }
      if (!all.length && failures.length === sitemaps.length) {
        throw new Error('nerdfilmes: todos os post-sitemaps falharam');
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
      // Contador de requisições REAIS desta página (F3: POR HOP — redirect e
      // salto de protetor contam cada um via `onRequest`; `magnet:` não faz
      // rede). O motor cobra no teto por hora.
      const counter = { n: 0 };
      const countRequest = () => { counter.n += 1; };
      const season = pageOpts?.kind === 'tv_show';
      if (season && !seriesProbe && !probeRequested(pageOpts) && pageOpts?.series?.enabled !== true) {
        // Séries desligadas: linha de temporada na fila (enfileirada com a opção
        // ligada) vira erro explicado, ZERO rede — a recusa é do portão.
        const message = 'nerdfilmes: página de temporada fora do motor (séries desligadas no painel)';
        log.warn(`[crawl] ${message}: ${url}`);
        return { url, status: 'error', error: message };
      }
      try {
        // Defesa em profundidade: a fila nasce da nossa descoberta, mas o store
        // pode ter sido editado — host de fora é rejeitado na porta. O gate
        // `/link.php` é de MESMO ORIGIN, então o host não o pega: a trava dele
        // é a FORMA da URL.
        const workUrl = assertSiteUrl(url);
        if (!isWorkPath(workUrl)) {
          throw new Error(`not_a_work_page:${workUrl.pathname.toLowerCase()}`);
        }
        if (!season && isSeasonSlug(workUrl)) {
          // Linha de QUEM não classificou por slug: gravar os botões de episódio
          // como filme é obra errada no acervo; recusar deixa a linha visível.
          const message = 'temporada_com_kind_movie: a página é de temporada e a fila a pediu como filme (reprocessar/zera o site)';
          log.warn(`[crawl] nerdfilmes: ${message}: ${url}`);
          return { url, status: 'error', error: message };
        }
        const pageHtml = await surface.fetchTextDirect(workUrl.href, undefined, { onRequest: countRequest });
        const { title, year } = parseTitleYear(pageHtml);
        if (!title) {
          // Página sem título é quebra de layout, não obra sem nome: erro para o
          // backoff do motor (e canário do painel), nunca release inventada.
          return { url, status: 'error', error: 'layout: página sem <h1> de título', requestCost: counter.n };
        }
        const imdb = parseImdbId(pageHtml);
        const links = surface.parseDownloadLinks(pageHtml, workUrl.href);
        const type = season ? 'series' as const : 'movie' as const;
        if (!links.length) {
          // Post sem botão (medido: 1 de 24) — só streaming, ou botão removido.
          // Terminal, sem gasto de protetor.
          return { url, status: 'no-torrent', imdb, title, year, type, requestCost: counter.n };
        }
        // Gate `/link.php` → protetor → magnet, UM botão por vez, na ordem da
        // página; falha de um botão não perde os demais. Todos terminais
        // (payload inválido/expirado, destino não-magnet) → `no-torrent` na 1ª
        // tentativa; mistura com rede/timeout continua retentável. Na AMOSTRA o
        // teto é o knob de série do motor (`CRAWL_SERIES_MAX_BUTTONS`): página
        // de 14 botões é a régua e um outlier não vira 200 requests.
        const maxButtons = Math.max(1, Math.trunc(Number(pageOpts?.series?.maxButtons ?? config.crawl.seriesMaxButtons) || config.crawl.seriesMaxButtons));
        const announced = links.length;
        const planned = season ? links.slice(0, maxButtons) : links;
        if (planned.length < announced) {
          log.warn(`[crawl] nerdfilmes: ${announced} botão(ões) na página de temporada, seguindo ${planned.length} (teto de série)`);
        }
        const obra = { title, year };
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
            if (!magnet) continue; // cadeia resolveu mas não há magnet: não inventa
            const hash = magnetHash(magnet);
            if (hash && seen.has(hash)) continue; // mesmo hash, botão repetido
            if (hash) seen.add(hash);
            releases.push(releaseToRawItem(surface, obra, link, magnet));
          } catch (err) {
            lastError = err;
            if (isTerminalButtonError(err, link.url, workUrl.href)) terminalFails += 1;
            else otherFails += 1;
            log.warn(`[crawl] nerdfilmes: botão falhou (${url}):`, log.errorMessage(err));
          }
        }
        if (!releases.length) {
          // Todos os botões terminais → sem torrent publicado neste post.
          if (terminalFails === planned.length && otherFails === 0 && followed === 0) {
            return { url, status: 'no-torrent', imdb, title, year, type, requestCost: counter.n };
          }
          // Nenhuma cadeia foi adiante: o erro real do transporte é a causa e
          // segue como está (com o custo medido anexado). Caso contrário, as
          // cadeias resolveram e nenhum magnet veio — o motivo conta os dois lados.
          if (!followed && lastError) throw lastError;
          const failed = planned.length - followed;
          const detail = lastError ? `; último erro: ${log.errorMessage(lastError)}` : '';
          throw new Error(
            `nerdfilmes: ${planned.length} botão(ões) anunciados, nenhum magnet `
            + `(${followed} sem magnet, ${failed} com falha)${detail}`,
          );
        }
        if (season) {
          // Série: nome sem "Nª Temporada" (o TMDB conhece "Lanternas"), a
          // temporada do post (janela de ano da identificação) e os grupos por
          // locação. `buttons`/`buttonsFollowed` são o denominador da sonda.
          const pageSeason = pageSeasonOf(title, workUrl.href);
          const sample: NerdfilmesSeasonSample = {
            url, status: 'done', imdb, title: cleanWorkName(title), year, season: pageSeason, type, releases,
            originalTitle: parseOriginalTitle(pageHtml),
            groups: seasonPageGroups(releases, { season: pageSeason, title }),
            requestCost: counter.n, buttons: announced, buttonsFollowed: followed,
          };
          return sample;
        }
        const originalTitle = parseOriginalTitle(pageHtml); // 2º nome da identificação
        return { url, status: 'done', imdb, title, year, originalTitle, type, releases, requestCost: counter.n };
      } catch (err) {
        // F1: throw NÃO perde o custo medido (F3, por hop).
        throw withRequestCost(err, counter.n);
      }
    },
  };
}

/**
 * Instância de produção: reusa o resolver nerdfilmes JÁ CARREGADO no processo
 * (mesmo seletor de domínio, mesmos protetores, mesmos caches). É este export
 * que o registry chama, e ele NUNCA liga `seriesProbe`: em produção a página de
 * temporada entra pela opção de séries do painel.
 */
export function nerdfilmesCrawlSite(): CrawlSite {
  const surface = instance(SITE_ID) as NerdfilmesResolverSurface | null;
  if (!surface || typeof surface.fetchTextDirect !== 'function') {
    throw new Error('nerdfilmes: resolvedor embutido não carregado — raspagem indisponível');
  }
  return createNerdfilmesCrawlSite(surface);
}
