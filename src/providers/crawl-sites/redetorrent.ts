// Adaptador de raspagem do RedeTorrent (Fase 8 — card `redetorrent-cardigann`,
// profile `redetorrent`; a ponte entre os dois nomes é este arquivo, o mesmo
// padrão do `torrentdosfilmesv2`↔`torrentdosfilmes`).
//
// O motor cuida de fila, ritmo e gravação; aqui só existem as duas respostas do
// contrato `CrawlSite`: `discover()` (índice AIOSEO → `movies-sitemap*.xml` /
// `tvshows-sitemap.xml` → obras com lastmod e tipo pelo caminho) e `fetchWork()`
// (post → tabela `tbl-mv-list` → magnet), sempre pelo resolver JÁ CARREGADO
// (`br-resolvers.instance`). As regras puras estão em
// `redetorrent-discovery.ts`; a medição que justifica cada escolha está no
// cabeçalho daquele arquivo e aqui embaixo, sem repetir.
//
// ── O QUE ESTE SITE É DIFERENTE (2026-09-28, medido via FlareSolverr) ────────
//
//  1. TUDO PASSA PELO CLOUDFLARE. Fetch direto de `robots.txt`, `/sitemap.xml`
//     e `/movies-sitemap.xml` devolve 403 "Just a moment..." nos três. Os
//     outros três sites do motor usam o `fetchTextDirect` do profile
//     (raspagem sem browser); aqui a descoberta e a leitura usam o `fetchText`
//     (direto → FlareSolverr, sessão de 20 min reaproveitada por host). É a
//     ÚNICA diferença de transporte, e ela é do SITE — não uma escolha de
//     economia de CPU.
//
//  2. O SITEMAP CHEGA COMO HTML, NÃO COMO XML. O FlareSolverr devolve o
//     visualizador XML do Chromium: uma tabela renderizada, sem nenhum `<loc>`.
//     O parser das linhas é o de `redetorrent-discovery.ts`; aqui não há
//     `<sitemap>`/`<url>` para casar.
//
//  3. A PÁGINA DE OBRA CUSTA 1 REQUISIÇÃO. O magnet é DIRETO na tabela
//     `tbl-mv-list` do post (`<a href="magnet:?xt=urn:btih:…">`), sem salto de
//     protetor: é o mesmo caminho do card vivo, que também resolve sem
//     `/resolve`. E o `parsePostLinks` do profile aceita as DUAS formas que o
//     site publica — o `magnet:` direto e o token `systemads` (base64) que o
//     JS do tema escreve no DOM já renderizado pelo browser, que é exatamente
//     o HTML que a raspagem recebe. Por isso o `requestCost` de uma página de
//     filme é 1, e o `maxButtons` dos outros sites (que existe para não pagar
//     um salto por botão) aqui não se aplica: seguir um botão não custa rede.
//
//  4. O `<h1>` TERMINA NO ANO ("Coringa: Delírio a Dois (2024)"), que é a forma
//     do ComandoTorrents — a régua compartilhada de `work-name.ts` serve, e a
//     do TorrentDosFilmes (ano no meio) NÃO é copiada.
//
// ── PORTÃO DE SÉRIE ────────────────────────────────────────────────────────
// O acervo tem 705 páginas em `/series/`, e o post de série deste site agrega
// MAIS DE UMA TEMPORADA no mesmo post (medido: "Fallout 1ª 2ª Temporada
// (2025)", ficha "Temporadas: 2"). Note que o botão NÃO é o problema: o
// `parsePostLinks` do profile lê a coluna de qualidade e devolve `season` por
// linha (o post real do Fallout rende S01 e S02). O que a amostra ainda não
// provou é a SEMÂNTICA de cada linha (qual delas é pack, qual é episódio, e o
// que uma página de `/series/` cobre da série inteira) — afirmar `groups` com
// essa base seria obra errada no acervo. Logo:
//   1. `discover()` só EMITE `tv_show` em modo amostra (`seriesProbe`);
//   2. `fetchWork(kind:'tv_show')` sem amostra é erro e ZERO rede;
//   3. página de série pedida como filme é recusada antes de qualquer fetch;
//   4. a amostra devolve as contagens do denominador e NÃO grava `groups`.
// `opts.series.enabled` não abre a porta: só registra o aviso.
//
// Travas herdadas do crawler: host do site em TODA URL derivada de conteúdo do
// site (loc do índice, loc do sitemap, URL de obra); descoberta PARCIAL não
// derruba a rodada; erro carrega o custo medido (F1, `withRequestCost`).
// Nada aqui grava banco, agenda nada nem liga o crawler.
import type { RawItem } from '../../../types/domain.js';
import type { ParsedResolverLink } from '../../../resolvers/types.js';
import type { ReleaseTitleInput, ReleaseTitlePost } from '../../../resolvers/release-format.js';
import type {
  CrawlDiscovery, CrawlPageKind, CrawlPageOptions, CrawlSite, CrawlWorkResult, CrawlDiscoverOptions, DiscoveredUrl,
} from '../crawl-types.js';
import { instance } from '../../br-resolvers.js';
import * as log from '../../utils/logger.js';
import { magnetHash, parseOriginalTitle, withRequestCost } from './shared.js';
import {
  isSeriesSitemap, isWorkPath, kindFromPath, parseImdbId, parseSitemapIndexLocs, parseSitemapRows,
  SITEMAP_INDEX_PATHS, toWorkUrl, workTitleYear,
} from './redetorrent-discovery.js';

/**
 * Recorte da instância do profile que o adaptador consome. Declarar a
 * superfície (em vez de `any`) faz o compilador cobrar os métodos contra a API
 * REAL do profile — quebra em compilação se o profile renomear algo. É
 * `import type` o que liga aqui: `src/` não importa o núcleo dos resolvers em
 * runtime, a instância é INJETADA (no processo do addon vem do
 * `br-resolvers.instance`, na sonda e nos testes vem do profile direto).
 */
export interface RedetorrentResolverSurface {
  siteSelector: { url(): string };
  assertAllowedUrl(value: string | null | undefined): URL;
  /** Host candidato do SITE (allowlist do failover) — páginas só dele. */
  isDetailHost(hostname: string | null | undefined): boolean;
  /** Direto → FlareSolverr. `onRequest` dispara UMA vez por chamada: o solve
   *  do Flare é o mesmo acesso (a sessão que ele abre é a do próximo direto). */
  fetchText(url: string | URL, referer?: string, hooks?: { onRequest?: () => void }): Promise<string>;
  parsePostLinks(html: string | null | undefined, post: string | { url?: string } | null | undefined): ParsedResolverLink[];
  releaseTitle(post: ReleaseTitlePost, link: ReleaseTitleInput, index?: number | null): string;
}

/**
 * `seriesProbe` é o MODO AMOSTRA: a única passagem autorizada para
 * `kind:'tv_show'`, e ela existe para a sonda da Fase 8 — nunca para o motor.
 * Mora aqui, e não em `CrawlPageOptions`, porque aquele é o contrato
 * COMPARTILHADO de todos os sites; `fetchWork` também aceita a mesma flag por
 * chamada (ver `probeRequested`) para quem só tem a interface `CrawlSite`.
 */
export interface RedetorrentCrawlOptions {
  seriesProbe?: boolean;
}

/**
 * Resultado da AMOSTRA de temporada: o contrato compartilhado não tem campo
 * para "quantas linhas a página anunciava", e é o denominador que a sonda
 * precisa. Quem só enxerga `CrawlWorkResult` continua com o contrato base.
 */
export interface RedetorrentSeasonSample extends CrawlWorkResult {
  /** Linhas de release com magnet na página (o denominador). */
  buttons: number;
  /** Linhas efetivamente lidas: aqui é o mesmo número, porque o magnet é
   *  direto no HTML (não há salto de protetor a seguir). */
  buttonsFollowed: number;
}

/** id do card do Jackett (o profile tem o nome `redetorrent`, sem sufixo). */
const SITE_ID = 'redetorrent-cardigann';
const TRACKER_LABEL = 'RedeTorrent';
/** Nome do PROFILE do resolver, que NÃO é o id do card — a ponte é aqui. */
const RESOLVER_NAME = 'redetorrent';

// `seriesProbe` por CHAMADA: o `CrawlPageOptions` compartilhado não tem o campo
// e não é meu para mudar — cast concentrado aqui, leitura por `=== true`.
function probeRequested(pageOpts?: CrawlPageOptions): boolean {
  return (pageOpts as { seriesProbe?: unknown } | undefined)?.seriesProbe === true;
}

/**
 * Fábrica do adaptador: recebe a superfície do resolver pronta (nos testes, a
 * instância real do profile com fetch dublê).
 */
export function createRedetorrentCrawlSite(
  surface: RedetorrentResolverSurface,
  options: RedetorrentCrawlOptions = {},
): CrawlSite {
  const seriesProbe = options.seriesProbe === true;

  /**
   * Página do SITE (host safety): loc de sitemap, loc de obra e URL de página
   * derivam de conteúdo do site — só hostname candidato serve. O host
   * rejeitado viaja no erro (diagnóstico do painel); o assert do resolver é a
   * segunda camada.
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
   * Índice de sitemaps: o canônico que o `robots.txt` declara (`/sitemap.xml`,
   * AIOSEO) e o nome Yoast como reserva. Precisa renderizar ao menos um
   * `movies-sitemap*`/`tvshows-sitemap*` para valer como resposta — o índice do
   * site tem 96 entradas e só 8 são de obra, então "veio HTML" não basta.
   */
  async function readSitemapIndex(onRequest: () => void): Promise<string> {
    const base = surface.siteSelector.url();
    const failures: string[] = [];
    for (const p of SITEMAP_INDEX_PATHS) {
      const url = new URL(p, base).href;
      try {
        const html = await surface.fetchText(url, undefined, { onRequest });
        if (parseSitemapIndexLocs(html, base, (h) => surface.isDetailHost(h)).length) return html;
        failures.push(`${url}: nenhum sitemap de obra no índice`);
      } catch (err) {
        failures.push(`${url}: ${log.errorMessage(err)}`);
      }
    }
    throw new Error(`redetorrent-cardigann: índice de sitemaps ilegível (${failures.join(' | ')})`);
  }

  /**
   * Um `movies-sitemap*`/`tvshows-sitemap*.xml`: as obras (URL + lastmod +
   * kind pelo caminho). O corte incremental é POR KIND (`sinceOf`) — o tipo de
   * uma página vem do caminho, e os cursores de filme e de série andam
   * separados para um não cortar o outro.
   */
  async function readWorkSitemap(
    loc: string,
    sinceOf: (kind: CrawlPageKind) => string | null,
    onRequest: () => void,
  ): Promise<DiscoveredUrl[]> {
    const html = await surface.fetchText(loc, undefined, { onRequest });
    const out: DiscoveredUrl[] = [];
    for (const row of parseSitemapRows(html)) {
      // Loc de post é INPUT do site: `/filmes/`, `/series/`, `/genero/…`,
      // `/page/N/` e qualquer host de fora saem aqui, sem virar requisição.
      const href = toWorkUrl(row.url, loc, (h) => surface.isDetailHost(h));
      if (!href) continue;
      const kind = kindFromPath(href);
      // Incremental: lastmod ≤ since já foi processado (o upsert do store é
      // idempotente, então o filtro é economia, não correção). Lastmod
      // ILEGÍVEL entra — não se perde obra por ruído de data, e inventar data
      // seria pior (cursor do motor anda para o lado errado).
      const since = sinceOf(kind);
      if (since) {
        const t = Date.parse(row.lastmod);
        const floor = Date.parse(since);
        if (Number.isFinite(t) && Number.isFinite(floor) && t <= floor) continue;
      }
      out.push({ url: href.href, lastmod: row.lastmod, kind });
    }
    return out;
  }

  return {
    id: SITE_ID,
    label: TRACKER_LABEL,

    async discover(since?: string | null, opts?: CrawlDiscoverOptions): Promise<CrawlDiscovery> {
      if (opts?.series?.enabled === true) {
        log.warn('[crawl] redetorrent-cardigann: séries ligadas na config, mas o post de série cobre MAIS DE UMA '
          + 'temporada (medido: "Fallout 1ª 2ª Temporada (2025)", "Temporadas: 2") — segue FORA do motor até a '
          + 'amostra separar pack de temporada');
      }
      // Só o MODO AMOSTRA emite `tv_show`. Sem ele a lista é de filmes e o
      // cursor de série não anda (sem URL do kind, `advanceCursors` não acha
      // `max`) — é o mesmo `true` que os outros sites declaram.
      const emitSeries = seriesProbe;
      const sinceByKind = opts?.sinceByKind;
      const sinceOf = (kind: CrawlPageKind): string | null => (
        sinceByKind && Object.prototype.hasOwnProperty.call(sinceByKind, kind)
          ? (sinceByKind[kind] ?? null)
          : (since ?? null)
      );
      // Custo REAL da rodada (F3, por chamada): índice + um fetch por sitemap de
      // obra. Sem isto a descoberta entraria de graça no teto por hora, que é
      // de requisições. O solve do FlareSolverr NÃO soma — ele é o mesmo
      // acesso, dentro da chamada contada.
      const counter = { n: 0 };
      const countRequest = () => { counter.n += 1; };
      const base = surface.siteSelector.url();
      const indexHtml = await readSitemapIndex(countRequest);
      const sitemaps = parseSitemapIndexLocs(indexHtml, base, (h) => surface.isDetailHost(h));
      if (!sitemaps.length) throw new Error('redetorrent-cardigann: nenhum sitemap de obra no índice');
      // Séries desligadas pulam o ARQUIVO de série inteiro: ele é separado dos
      // filmes (ao contrário do `post-sitemap` misto dos outros sites), então
      // buscá-lo seria uma requisição por rodada para URLs que o portão
      // recusaria na fila.
      const planned = emitSeries ? sitemaps : sitemaps.filter((loc) => !isSeriesSitemap(loc));
      // Sequencial (constraint crawl.search_isolation): um pedido por vez.
      // Sitemap que falha não derruba a rodada — vira descoberta PARCIAL, e o
      // cursor não avança por cima do que ficou nos arquivos perdidos.
      const all: DiscoveredUrl[] = [];
      const failures: string[] = [];
      for (const loc of planned) {
        try {
          all.push(...await readWorkSitemap(loc, sinceOf, countRequest));
        } catch (err) {
          failures.push(`${loc}: ${log.errorMessage(err)}`);
          log.warn(`[crawl] redetorrent-cardigann: sitemap falhou (${loc}):`, log.errorMessage(err));
        }
      }
      if (planned.length && !all.length && failures.length === planned.length) {
        throw new Error('redetorrent-cardigann: todos os sitemaps de obra falharam');
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
      const season = pageOpts?.kind === 'tv_show';
      if (season && !seriesProbe && !probeRequested(pageOpts)) {
        // A descoberta não enfileira série; se uma linha chegar assim (fila
        // editada à mão, resíduo de outro site), o erro explica por quê em vez
        // de gravar o post multi-temporada como filme. ZERO rede: a recusa é do
        // portão, não do site.
        const message = 'redetorrent-cardigann: página de série fora do motor '
          + '(o post cobre mais de uma temporada; só o modo amostra seriesProbe lê)';
        log.warn(`[crawl] ${message}: ${url}`);
        return { url, status: 'error', error: message };
      }
      // Contador de requisições REAIS desta página (F3). O magnet é direto no
      // HTML, então o número medido é 1 — mas ele é CONTADO, não assumido: a
      // régua existe para o teto por hora e o número errado cobra caro.
      const counter = { n: 0 };
      const countRequest = () => { counter.n += 1; };
      try {
        // Defesa em profundidade: a fila nasce da nossa descoberta, mas o store
        // pode ter sido editado — host de fora é rejeitado na porta.
        const workUrl = assertSiteUrl(url);
        if (!isWorkPath(workUrl)) {
          throw new Error(`not_a_work_page:${workUrl.pathname.toLowerCase()}`);
        }
        if (!season && kindFromPath(workUrl) === 'tv_show') {
          // Linha de QUEM não classificou pelo caminho: gravar o post de série
          // como filme é obra errada no acervo; recusar deixa a linha visível.
          const message = 'serie_com_kind_movie: a página é de série e a fila a pediu como filme '
            + '(reprocessar/zera o site)';
          log.warn(`[crawl] redetorrent-cardigann: ${message}: ${url}`);
          return { url, status: 'error', error: message };
        }
        // 1 REQUISIÇÃO: o HTML do post já carrega o magnet na `tbl-mv-list`.
        const pageHtml = await surface.fetchText(workUrl.href, undefined, { onRequest: countRequest });
        const { title, year, raw } = workTitleYear(pageHtml);
        if (!title) {
          // Página sem nome é quebra de layout, não obra sem nome: erro para o
          // backoff do motor (e canário do painel), nunca release inventada.
          return { url, status: 'error', error: 'layout: página sem <h1> de título', requestCost: counter.n };
        }
        // tt ÚNICO na página = o da obra. Dois ou nenhum é ambíguo (widget de
        // recomendação), e a identificação cai para título+ano. O widget de
        // NOTA do site (`nota-imdb`, medido nos cards de busca) não traz `tt`.
        const imdb = parseImdbId(pageHtml);
        // O `post` do parser resolve href relativo e é o que o card vivo
        // entrega; o mesmo parser lê o `magnet:` direto e o token `systemads`
        // do DOM já renderizado, então o HTML que o FlareSolverr devolve entra
        // pelo mesmo caminho.
        const links = surface.parsePostLinks(pageHtml, { url: workUrl.href });
        const type = season ? 'series' as const : 'movie' as const;
        if (!links.length) {
          // Post sem linha de release: terminal, sem gastar nada além da
          // página (que é o estado honesto — nada publicável neste post).
          return { url, status: 'no-torrent', imdb, title, year, type, requestCost: counter.n };
        }
        const releases: RawItem[] = [];
        const seen = new Set<string>();
        for (const link of links) {
          const magnet = link.url;
          const hash = magnetHash(magnet);
          if (hash && seen.has(hash)) continue;
          if (hash) seen.add(hash);
          releases.push({
            // `raw` é o `<h1>` CRU: é o que o `releaseTitle` do profile limpa, e
            // é byte a byte o `title=` do card de busca — a mesma régua que o
            // card vivo usa. Limpar aqui produziria uma segunda régua.
            title: surface.releaseTitle(raw, link),
            magnet,
            indexer: SITE_ID,
            tracker: TRACKER_LABEL,
            // Origem BR é campo do provider. Fonte BR não publica swarm; 1
            // sobrevive ao MIN_SEEDERS.
            isBr: true,
            seeders: 1,
          });
        }
        if (!releases.length) {
          return { url, status: 'no-torrent', imdb, title, year, type, requestCost: counter.n };
        }
        if (season) {
          // Modo leitura: releases e contagens do denominador, SEM `groups` —
          // afirmar a locação de cada linha é justamente o que a amostra ainda
          // não provou (o post de série deste site agrega várias temporadas).
          const sample: RedetorrentSeasonSample = {
            url, status: 'done', imdb, title, year, type, releases,
            requestCost: counter.n, buttons: links.length, buttonsFollowed: links.length,
          };
          return sample;
        }
        // A ficha declara o título original: 2º nome da identificação, quando o
        // `<h1>` não casa ninguém. Este site não publica o span do NerdFilmes;
        // o helper também lê a ficha `<b>Título Original:</b>` dos WordPress BR,
        // e `null` aqui é o estado normal (identificação segue só com o `<h1>`).
        const originalTitle = parseOriginalTitle(pageHtml);
        return { url, status: 'done', imdb, title, year, originalTitle, type, releases, requestCost: counter.n };
      } catch (err) {
        // F1: throw NÃO perde o custo medido (F3).
        throw withRequestCost(err, counter.n);
      }
    },
  };
}

/**
 * Instância de produção: reusa o resolver `redetorrent` JÁ CARREGADO no processo
 * (mesmo seletor de domínio, mesma sessão de FlareSolverr, mesmos caches). É
 * este export que o registry chama, e ele NUNCA liga `seriesProbe`: produção
 * segue com séries desligadas.
 */
export function redetorrentCrawlSite(): CrawlSite {
  const surface = instance(RESOLVER_NAME) as RedetorrentResolverSurface | null;
  if (!surface || typeof surface.fetchText !== 'function') {
    throw new Error('redetorrent-cardigann: resolvedor embutido não carregado — raspagem indisponível');
  }
  return createRedetorrentCrawlSite(surface);
}
