// Adaptador de raspagem do TorrentDosFilmes V2 (Fase 8 — terceiro site do
// motor multi-site, e o PRIMEIRO em que o `id` do card e o nome do profile
// divergem: card `torrentdosfilmesv2`, profile `torrentdosfilmes`).
//
// O motor cuida de fila, ritmo e gravação; aqui só existem as duas respostas do
// contrato `CrawlSite`: `discover()` (índice de sitemaps → `post-sitemap*.xml` →
// obras com lastmod e TIPO pelo slug) e `fetchWork()` (post → âncoras de magnet →
// magnet), sempre pelo resolver JÁ CARREGADO (`br-resolvers.instance`). As
// regras puras de sitemap, slug, tipo e NOME DA OBRA foram para
// `torrentdosfilmes-discovery.ts`, e o percurso dos botões para
// `torrentdosfilmes-buttons.ts` (as duas extrações são da catraca de 400
// linhas); aqui mora o que faz REDE.
//
// TRÊS MEDIÇÕES DO SITE (2026-09-28) que organizam o arquivo inteiro:
//
//  1. O MAGNET É DIRETO NO POST. Não há salto de protetor no caminho comum: o
//     botão é `<a href="magnet:?…&amp;dn=…">` (1 a 3 por página, medido) e, sem
//     texto — a imagem do botão é um `<img src="…/botao.png">`. O `laço do
//     núcleo devolve o magnet sem gastar rede quando a entrada já é `magnet:`, e
//     por isso uma página de filme deste site custa 1 request, contra "página +
//     1 por botão" no NerdFilmes. O que sobra do botão é o título da release, e
//     ele sai como o profile sempre produziu no card vivo: aqui não há segunda
//     régua de título.
//  2. O `<h1>` TEM O ANO NO MEIO e o nome vem antes do ruído de vitrine, então a
//     régua do nome é a do `torrentdosfilmes-discovery.ts` (o `parseTitleYear`
//     compartilhado devolveria `year: null` em TODA página deste site, e página
//     sem ano não chega a consultar o TMDB).
//  3. O IMDB DESTA PÁGINA É ARMADILHA. O site publica um plugin de recomendação
//     cujo link do IMDb é de obra ALEATÓRIA (medido: em "Como Viajar com o
//     Mala do seu Pai (2008)" o único tt é `tt1959490` = "Refém (2005)"). Por
//     isso `imdb` é SEMPRE `null` e a identificação é por título+ano. Copiar
//     aqui a regra de unicidade do NerdFilmes gravaria obra errada no acervo —
//     o pior desfecho possível, e o que a `CrawlWorkResult.imdb` promete não
//     fazer ("obra errada é pior que obra nenhuma").
//
// PORTÃO DE SÉRIE (mesma decisão medida no NerdFilmes, agora com prova melhor):
// a página de temporada deste site é PACK de temporada (o `dn=` do magnet é
// `…S01Complete`, medido) e o botão não traz rastro de episódio. 118 dos 1.000
// slugs de obra (11,8%) são de temporada. Então: `discover()` rotula `tv_show` e
// NÃO emite essas URLs; `fetchWork(kind:'tv_show')` só processa em MODO AMOSTRA
// (`{ seriesProbe:true }`), e página de temporada chegada como `movie` é recusada
// na porta. Gravar um pack como filme é obra que não existe no catálogo.
// `opts.series.enabled` NÃO abre nada: a flag produz aviso.
//
// Travas herdadas do crawler: host safety em TODA URL derivada de conteúdo do
// site (loc do índice, loc do sitemap, URL de obra); crawl NÃO aciona
// FlareSolverr (o `fetchTextDirect` do profile é o caminho direto e o site
// responde 200 sem desafio — medido); descoberta PARCIAL não derruba a rodada;
// erro carrega o custo medido (F1, `withRequestCost`).
// Nada aqui grava banco, agenda nada nem liga o crawler.
import config from '../../config.js';
import type { ResolverLink } from '../../../resolvers/types.js';
import type { ReleaseTitleInput } from '../../../resolvers/release-format.js';
import type {
  CrawlDiscovery, CrawlPageKind, CrawlPageOptions, CrawlSite, CrawlWorkResult, CrawlDiscoverOptions, DiscoveredUrl,
} from '../crawl-types.js';
import { instance } from '../../br-resolvers.js';
import * as log from '../../utils/logger.js';
import { parseOriginalTitle, withRequestCost } from './shared.js';
import { TDF_SITE_ID, TDF_TRACKER_LABEL, passButtons } from './torrentdosfilmes-buttons.js';
import {
  isSeasonSlug, isWorkPath, kindFromSlug, parseSitemapEntries, parseSitemapIndexLocs,
  SITEMAP_INDEX_PATHS, toWorkUrl, workTitleYear,
} from './torrentdosfilmes-discovery.js';

/**
 * Recorte da instância do profile torrentdosfilmes que o adaptador consome.
 * Declarar a superfície aqui (em vez de `any`) faz o compilador cobrar os
 * métodos contra a API REAL do profile — quebra em compilação se o profile
 * renomear algo.
 */
export interface TorrentdosfilmesResolverSurface {
  siteSelector: { url(): string };
  assertAllowedUrl(value: string | null | undefined): URL;
  /** Host candidato do SITE (allowlist do failover) — páginas só dele. */
  isDetailHost(hostname: string | null | undefined): boolean;
  /** Fetch direto do profile, SEM FlareSolverr, com contagem por HOP (F3). */
  fetchTextDirect(url: string, accept?: string, hooks?: { onRequest?: () => void }): Promise<string>;
  parseDownloadLinks(html: string | null | undefined, baseUrl?: string): ResolverLink[];
  fetchFollowingAllowed(value: string, referer?: string | null, hooks?: { onRequest?: () => void }): Promise<string>;
  extractMagnet(html: string | null | undefined): string | null;
  releaseTitle(post: string, link: ReleaseTitleInput, index?: number | null): string;
  parseSize(text: string | null | undefined): number | null;
}

/**
 * Opções PRÓPRIAS do adaptador. `seriesProbe` é o MODO AMOSTRA: a única
 * passagem autorizada para `kind:'tv_show'`, e ela existe para a sonda da Fase 8
 * — nunca para o motor. Mora aqui, e não em `CrawlPageOptions`, porque aquele é
 * o contrato COMPARTILHADO de todos os sites; `fetchWork` também aceita a mesma
 * flag por chamada (ver `probeRequested`), para quem só tem a interface
 * `CrawlSite` em mãos.
 */
export interface TorrentdosfilmesCrawlOptions {
  seriesProbe?: boolean;
}

/**
 * Resultado da AMOSTRA de temporada: o contrato compartilhado não tem campo
 * para "quantos botões a página anunciava", e é o denominador que a sonda
 * precisa. Quem só enxerga `CrawlWorkResult` continua com o contrato base.
 */
export interface TorrentdosfilmesSeasonSample extends CrawlWorkResult {
  /** Botões de torrent anunciados na página (o denominador). */
  buttons: number;
  /** Botões que o transporte chegou a seguir (o outro lado da régua). */
  buttonsFollowed: number;
}

/** id do card do Jackett (dedupe, `ji`/`jl`, reserva por indexer falho). */
const SITE_ID = TDF_SITE_ID;
const TRACKER_LABEL = TDF_TRACKER_LABEL;
/**
 * Nome do PROFILE do resolver, que NÃO é o id do card: o card é
 * `torrentdosfilmesv2` e o profile é `torrentdosfilmes` (mesma divergência que
 * `redetorrent-cardigann`↔`redetorrent`). `br-resolvers.instance()` é indexado
 * pelo nome do profile — usar o id do card aqui devolveria `null` e a raspagem
 * seria declarada indisponível em produção.
 */
const RESOLVER_NAME = 'torrentdosfilmes';

// `seriesProbe` por CHAMADA: o `CrawlPageOptions` compartilhado não tem o campo
// e não é meu para mudar — cast concentrado aqui, leitura por `=== true`.
function probeRequested(pageOpts?: CrawlPageOptions): boolean {
  return (pageOpts as { seriesProbe?: unknown } | undefined)?.seriesProbe === true;
}

/**
 * Fábrica do adaptador: recebe a superfície do resolver pronta (nos testes, a
 * instância real do profile com fetch dublê).
 */
export function createTorrentdosfilmesCrawlSite(
  surface: TorrentdosfilmesResolverSurface,
  options: TorrentdosfilmesCrawlOptions = {},
): CrawlSite {
  const seriesProbe = options.seriesProbe === true;

  /**
   * Página do SITE (host safety): loc de sitemap, loc de obra e URL de página
   * derivam de conteúdo do site — só hostname candidato serve como página. O
   * host rejeitado viaja no erro (diagnóstico do painel); o assert do resolver é
   * a segunda camada.
   */
  function assertSiteUrl(value: string): URL {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error('invalid_url'); }
    if (!surface.isDetailHost(parsed.hostname)) {
      throw new Error(`blocked_host:${parsed.hostname.toLowerCase()}`);
    }
    return surface.assertAllowedUrl(value);
  }

  /**
   * Índice de sitemaps: o canônico que o `robots.txt` declara, e o nome Yoast
   * como reserva (que é 301 para o canônico — o laço de redirects segue com
   * allowlist por hop e devolve o mesmo XML).
   */
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
    throw new Error(`torrentdosfilmesv2: índice de sitemaps ilegível (${failures.join(' | ')})`);
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
    for (const entry of parseSitemapEntries(xml)) {
      // Loc de post é INPUT do site: a home `/` (que o índice do site inclui) e
      // qualquer host de fora saem aqui, sem virar requisição nem fila.
      const href = toWorkUrl(entry.loc, loc, (h) => surface.isDetailHost(h));
      if (!href) continue;
      const kind = kindFromSlug(href);
      // Incremental: lastmod ≤ since já foi processado (upsert do store é
      // idempotente, então o filtro é economia, não correção). Lastmod ilegível
      // entra — não se perde obra por ruído de data.
      const since = sinceOf(kind);
      if (since) {
        const t = Date.parse(entry.lastmod);
        const floor = Date.parse(since);
        if (Number.isFinite(t) && Number.isFinite(floor) && t <= floor) continue;
      }
      out.push({ url: href.href, lastmod: entry.lastmod, kind });
    }
    return out;
  }

  return {
    id: SITE_ID,
    label: TRACKER_LABEL,

    async discover(since?: string | null, opts?: CrawlDiscoverOptions): Promise<CrawlDiscovery> {
      if (opts?.series?.enabled === true) {
        log.warn('[crawl] torrentdosfilmesv2: séries ligadas na config, mas a página de temporada é PACK '
          + '(dn=…S01Complete, medido) e o botão não traz episódio — segue FORA do motor até a amostra medir');
      }
      // Só o MODO AMOSTRA emite `tv_show`. Sem ele a lista é de filmes e o cursor
      // de série não anda (sem URL do kind `advanceCursors` não acha `max`).
      const emitSeries = seriesProbe;
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
      if (!sitemaps.length) throw new Error('torrentdosfilmesv2: nenhum post-sitemap no índice');
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
          log.warn(`[crawl] torrentdosfilmesv2: sitemap falhou (${loc}):`, log.errorMessage(err));
        }
      }
      if (!all.length && failures.length === sitemaps.length) {
        throw new Error('torrentdosfilmesv2: todos os post-sitemaps falharam');
      }
      const complete = failures.length === 0;
      return {
        urls: emitSeries ? all : all.filter((u) => u.kind === 'movie'),
        complete,
        failures,
        completeByKind: { movie: complete, tv_show: emitSeries ? complete : true },
        requestCost: counter.n,
      };
    },

    async fetchWork(url: string, pageOpts?: CrawlPageOptions): Promise<CrawlWorkResult> {
      // Contador de requisições REAIS desta página (F3: POR HOP). O motor cobra
      // no teto por hora.
      const counter = { n: 0 };
      const countRequest = () => { counter.n += 1; };
      const season = pageOpts?.kind === 'tv_show';
      if (season && !seriesProbe && !probeRequested(pageOpts)) {
        // A descoberta não enfileira série; se uma linha chegar assim (fila
        // editada à mão, resíduo de outro site), o erro explica por quê em vez
        // de gravar um PACK de temporada como filme. ZERO rede: a recusa é do
        // portão, não do site.
        const message = 'torrentdosfilmesv2: página de temporada (pack) fora do motor '
          + '(séries desligadas; só o modo amostra seriesProbe lê)';
        log.warn(`[crawl] ${message}: ${url}`);
        return { url, status: 'error', error: message };
      }
      try {
        // Defesa em profundidade: a fila nasce da nossa descoberta, mas o store
        // pode ter sido editado — host de fora é rejeitado na porta.
        const workUrl = assertSiteUrl(url);
        if (!isWorkPath(workUrl)) {
          throw new Error(`not_a_work_page:${workUrl.pathname.toLowerCase()}`);
        }
        if (!season && isSeasonSlug(workUrl)) {
          // Linha de QUEM não classificou por slug: gravar o pack como filme é
          // obra errada no acervo; recusar deixa a linha visível.
          const message = 'temporada_com_kind_movie: a página é de temporada (pack) e a fila a pediu como filme '
            + '(reprocessar/zera o site)';
          log.warn(`[crawl] torrentdosfilmesv2: ${message}: ${url}`);
          return { url, status: 'error', error: message };
        }
        const pageHtml = await surface.fetchTextDirect(workUrl.href, undefined, { onRequest: countRequest });
        const { title, year, raw } = workTitleYear(pageHtml);
        if (!title) {
          // Página sem nome é quebra de layout, não obra sem nome: erro para o
          // backoff do motor (e canário do painel), nunca release inventada.
          return { url, status: 'error', error: 'layout: página sem <h1> de título', requestCost: counter.n };
        }
        // `imdb` é SEMPRE null: o IMDb desta página é o do plugin de
        // recomendação, que aponta para obra ALEATÓRIA (medido: "Como Viajar com
        // o Mala do seu Pai (2008)" com tt de "Refém (2005)"). A identificação
        // é por título+ano — o caminho real deste site.
        const imdb = null;
        const links = surface.parseDownloadLinks(pageHtml, workUrl.href);
        const type = season ? 'series' as const : 'movie' as const;
        if (!links.length) {
          // Post sem botão (só streaming, ou o post é "torrentgdrive" sem
          // magnet). Terminal, sem gastar rede de protetor.
          return { url, status: 'no-torrent', imdb, title, year, type, requestCost: counter.n };
        }
        // Na AMOSTRA o teto é o knob de série do motor (`CRAWL_SERIES_MAX_BUTTONS`):
        // página com muitos botões é a régua e um outlier não vira 200 requests.
        const maxButtons = Math.max(1, Math.trunc(Number(pageOpts?.series?.maxButtons ?? config.crawl.seriesMaxButtons) || config.crawl.seriesMaxButtons));
        const announced = links.length;
        const planned = season ? links.slice(0, maxButtons) : links;
        if (planned.length < announced) {
          log.warn(`[crawl] torrentdosfilmesv2: ${announced} botão(ões) na página de temporada, `
            + `seguindo ${planned.length} (teto de série)`);
        }
        const pass = await passButtons(
          { surface, workUrl: workUrl.href, postTitle: raw, countRequest },
          planned,
        );
        if (!pass.releases.length) {
          // Todos os botões terminais → sem torrent publicado neste post.
          if (pass.terminalFails === planned.length && pass.otherFails === 0 && pass.followed === 0) {
            return { url, status: 'no-torrent', imdb, title, year, type, requestCost: counter.n };
          }
          // Nenhuma cadeia foi adiante: o erro real do transporte é a causa e
          // segue como está (com o custo medido anexado). Caso contrário, as
          // cadeias resolveram e nenhum magnet veio — o motivo conta os dois lados.
          if (!pass.followed && pass.lastError) throw pass.lastError;
          const failed = planned.length - pass.followed;
          const detail = pass.lastError ? `; último erro: ${log.errorMessage(pass.lastError)}` : '';
          throw new Error(
            `torrentdosfilmesv2: ${planned.length} botão(ões) anunciados, nenhum magnet `
            + `(${pass.followed} sem magnet, ${failed} com falha)${detail}`,
          );
        }
        if (season) {
          // Modo leitura: releases e contagens do denominador, SEM `groups` —
          // afirmar a locação de cada botão é o que a amostra ainda não provou
          // (e o pack deste site não tem episódio por botão, medido).
          const sample: TorrentdosfilmesSeasonSample = {
            url, status: 'done', imdb, title, year, type, releases: pass.releases,
            requestCost: counter.n, buttons: announced, buttonsFollowed: pass.followed,
          };
          return sample;
        }
        // A ficha declara o título original: 2º nome da identificação (o IMDb daqui é armadilha).
        const originalTitle = parseOriginalTitle(pageHtml);
        return { url, status: 'done', imdb, title, year, originalTitle, type, releases: pass.releases, requestCost: counter.n };
      } catch (err) {
        // F1: throw NÃO perde o custo medido (F3, por hop).
        throw withRequestCost(err, counter.n);
      }
    },
  };
}

/**
 * Instância de produção: reusa o resolver torrentdosfilmes JÁ CARREGADO no
 * processo (mesmo seletor de domínio, mesmos protetores, mesmos caches). É este
 * export que o registry chama, e ele NUNCA liga `seriesProbe`: produção segue
 * com séries desligadas.
 */
export function torrentdosfilmesCrawlSite(): CrawlSite {
  const surface = instance(RESOLVER_NAME) as TorrentdosfilmesResolverSurface | null;
  if (!surface || typeof surface.fetchTextDirect !== 'function') {
    throw new Error('torrentdosfilmesv2: resolvedor embutido não carregado — raspagem indisponível');
  }
  return createTorrentdosfilmesCrawlSite(surface);
}
