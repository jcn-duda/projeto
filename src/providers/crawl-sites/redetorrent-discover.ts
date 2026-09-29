// Descoberta do RedeTorrent: índice de sitemaps → `movies-sitemap*.xml` /
// `tvshows-sitemap*.xml` → obras com `lastmod` e tipo pelo caminho. É a metade
// "para cima" do adaptador (`redetorrent.ts` cuida da leitura da página), extraída
// pelo mesmo motivo que o Vaca tem `vaca-series.ts`: a fábrica do `CrawlSite` é
// um arquivo só e as duas metades já não cabiam no teto de linhas.
//
// Nada aqui grava banco, agenda nada nem liga o crawler. A medição que
// justifica as regras está no cabeçalho de `redetorrent-discovery.ts` (e os
// dois formatos de sitemap que o site devolve, sem os quais metade das rodadas
// volta com zero URL).
//
// A REGRA DURA que este módulo existe para sustentar: `urls: []` com
// `complete: true` NUNCA sai daqui. Essa combinação faz o cursor do crawler
// avançar por cima de um acervo que ninguém leu — 6.737 páginas de filme e 705
// de série, no pior caso — e ela é silenciosa por definição. Tudo o que o
// parser não entende, arquivo sem entrada, arquivo sem URL do tipo que ele
// alimenta e índice sem fonte de obra viram FALHA (parcial com `failures`, ou
// exceção quando não sobrou fonte nenhuma), nunca rodapé "vazio e completo".
import type {
  CrawlDiscoverOptions, CrawlDiscovery, CrawlPageKind, DiscoveredUrl,
} from '../crawl-types.js';
// Tipo do adaptador: importado só para a assinatura, e apagado na compilação —
// não existe aresta de runtime entre os dois arquivos.
import type { RedetorrentResolverSurface } from './redetorrent.js';
import * as log from '../../utils/logger.js';
import {
  isSeriesSitemap, kindFromPath, parseSitemapIndexLocs, parseSitemapRows,
  SITEMAP_INDEX_PATHS, sitemapShape, toWorkUrl,
} from './redetorrent-discovery.js';

/** A assinatura de `CrawlSite.discover` que este módulo entrega. */
export type RedetorrentDiscover = (since?: string | null, opts?: CrawlDiscoverOptions) => Promise<CrawlDiscovery>;

/** Motivo de recusa compartilhado, para o log e para o painel lerem igual. */
const SHAPE_MOTIVE = 'formato de sitemap não reconhecido (nem XML nem tabela do visualizador)';

/**
 * Fábrica da descoberta. `seriesProbe` é o MODO AMOSTRA (o mesmo booleano que
 * a fábrica do adaptador aplica a `fetchWork`): sem ele nenhum `tv_show` é
 * emitido e o arquivo de série nem é requisitado.
 */
export function createRedetorrentDiscoverer(
  surface: RedetorrentResolverSurface,
  seriesProbe: boolean,
): RedetorrentDiscover {
  /**
   * Índice de sitemaps: o canônico que o `robots.txt` declara (`/sitemap.xml`,
   * AIOSEO) e o nome Yoast como reserva. Precisa renderizar ao menos um
   * `movies-sitemap*`/`tvshows-sitemap*` para valer como resposta — o índice do
   * site tem 96 entradas e só 8 são de obra, então "veio resposta" não basta. O
   * motivo viaja na falha, porque "formato não reconhecido" e "índice sem
   * sitemap de obra" são defeitos de coisas diferentes.
   */
  async function readSitemapIndex(onRequest: () => void): Promise<string> {
    const base = surface.siteSelector.url();
    const failures: string[] = [];
    for (const p of SITEMAP_INDEX_PATHS) {
      const url = new URL(p, base).href;
      try {
        const html = await surface.fetchText(url, undefined, { onRequest });
        if (parseSitemapIndexLocs(html, base, (h) => surface.isDetailHost(h)).length) return html;
        failures.push(`${url}: ${sitemapShape(html) === 'unknown' ? SHAPE_MOTIVE : 'nenhum sitemap de obra no índice'}`);
      } catch (err) {
        failures.push(`${url}: ${log.errorMessage(err)}`);
      }
    }
    throw new Error(`redetorrent-cardigann: índice de sitemaps ilegível (${failures.join(' | ')})`);
  }

  /**
   * Um `movies-sitemap*`/`tvshows-sitemap*.xml`: as obras (URL + lastmod + kind
   * pelo caminho). O corte incremental é POR KIND (`sinceOf`) — o tipo de uma
   * página vem do caminho, e os cursores de filme e de série andam separados
   * para um não cortar o outro.
   *
   * As três recusas viram ERRO (e não lista vazia), porque cada uma é a forma
   * silenciosa de o cursor avançar sobre acervo nunca lido:
   *   1. resposta em formato que o parser não entende (e que o site pode
   *      alternar a cada sessão do browser — os DOIS formatos legítimos já
   *      estão no parser; o terceiro é quebra de layout ou interstitial);
   *   2. sitemap lido, mas sem NENHUMA entrada (o arquivo real tem 1.000);
   *   3. entradas existem, mas nenhuma é do tipo que o arquivo alimenta — o
   *      `tvshows-sitemap` do site também traz uma linha em `/filmes/`, então
   *      o corte é pelo TIPO DA LINHA, não pelo nome do arquivo.
   * A contagem é feita ANTES do corte incremental, senão uma rodada em que
   * tudo já foi processado acusaria falha em todos os arquivos.
   */
  async function readWorkSitemap(
    loc: string,
    sinceOf: (kind: CrawlPageKind) => string | null,
    onRequest: () => void,
  ): Promise<DiscoveredUrl[]> {
    const html = await surface.fetchText(loc, undefined, { onRequest });
    if (sitemapShape(html) === 'unknown') throw new Error(SHAPE_MOTIVE);
    const rows = parseSitemapRows(html);
    if (!rows.length) throw new Error('sitemap sem nenhuma entrada');
    const kindOfFile: CrawlPageKind = isSeriesSitemap(loc) ? 'tv_show' : 'movie';
    const out: DiscoveredUrl[] = [];
    let rowsOfKind = 0;
    for (const row of rows) {
      // Loc de post é INPUT do site: `/filmes/`, `/series/`, `/genero/…`,
      // `/page/N/` e qualquer host de fora saem aqui, sem virar requisição.
      const href = toWorkUrl(row.url, loc, (h) => surface.isDetailHost(h));
      if (!href) continue;
      const kind = kindFromPath(href);
      if (kind === kindOfFile) rowsOfKind += 1;
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
    if (!rowsOfKind) {
      throw new Error(`sitemap sem URL de ${kindOfFile} (${rows.length} entrada(s), nenhuma do tipo do arquivo)`);
    }
    return out;
  }

  return async function discover(since?: string | null, opts?: CrawlDiscoverOptions): Promise<CrawlDiscovery> {
    if (opts?.series?.enabled === true) {
      log.warn('[crawl] redetorrent-cardigann: séries ligadas na config, mas o post de série cobre MAIS DE UMA '
        + 'temporada (medido: "Fallout 1ª 2ª Temporada (2025)", "Temporadas: 2") — segue FORA do motor até a '
        + 'amostra separar pack de temporada');
    }
    // Só o MODO AMOSTRA emite `tv_show`. Sem ele a lista é de filmes e o cursor
    // de série não anda (sem URL do kind, `advanceCursors` não acha `max`) — é
    // o mesmo `true` que os outros sites declaram.
    const emitSeries = seriesProbe;
    const sinceByKind = opts?.sinceByKind;
    const sinceOf = (kind: CrawlPageKind): string | null => (
      sinceByKind && Object.prototype.hasOwnProperty.call(sinceByKind, kind)
        ? (sinceByKind[kind] ?? null)
        : (since ?? null)
    );
    // Custo REAL da rodada (F3, por chamada): índice + um fetch por sitemap de
    // obra. Sem isto a descoberta entraria de graça no teto por hora, que é de
    // requisições. O solve do FlareSolverr NÃO soma — ele é o mesmo acesso,
    // dentro da chamada contada.
    const counter = { n: 0 };
    const countRequest = () => { counter.n += 1; };
    const base = surface.siteSelector.url();
    const indexHtml = await readSitemapIndex(countRequest);
    const sitemaps = parseSitemapIndexLocs(indexHtml, base, (h) => surface.isDetailHost(h));
    if (!sitemaps.length) throw new Error('redetorrent-cardigann: nenhum sitemap de obra no índice');
    // Séries desligadas pulam o ARQUIVO de série inteiro: ele é separado dos
    // filmes (ao contrário do `post-sitemap` misto dos outros sites), então
    // buscá-lo seria uma requisição por rodada para URL que o portão recusa.
    const planned = emitSeries ? sitemaps : sitemaps.filter((loc) => !isSeriesSitemap(loc));
    if (!planned.length) {
      // Índice só com sitemap de SÉRIE e séries desligadas: não existe fonte de
      // filme nesta rodada, e devolver `urls: []` com `complete: true`
      // declararia o acervo de filme lido quando ele não foi tocado.
      throw new Error('redetorrent-cardigann: o índice só tem sitemap de série e séries estão desligadas');
    }
    // Sequencial (constraint crawl.search_isolation): um pedido por vez. Sitemap
    // que falha não derruba a rodada — vira descoberta PARCIAL, e o cursor não
    // avança por cima do que ficou nos arquivos perdidos. Cada falha marca o
    // KIND que ficou sem fonte, porque o cursor de filme não pode ser refém da
    // falha do arquivo de série (e vice-versa).
    const all: DiscoveredUrl[] = [];
    const failures: string[] = [];
    const failedKinds = new Set<CrawlPageKind>();
    for (const loc of planned) {
      try {
        all.push(...await readWorkSitemap(loc, sinceOf, countRequest));
      } catch (err) {
        failures.push(`${loc}: ${log.errorMessage(err)}`);
        failedKinds.add(isSeriesSitemap(loc) ? 'tv_show' : 'movie');
        log.warn(`[crawl] redetorrent-cardigann: sitemap falhou (${loc}):`, log.errorMessage(err));
      }
    }
    if (failures.length === planned.length) {
      throw new Error('redetorrent-cardigann: todos os sitemaps de obra falharam');
    }
    const complete = failures.length === 0;
    const urls = emitSeries ? all : all.filter((u) => u.kind === 'movie');
    if (!urls.length) {
      // O contador de entradas lidas entra na mensagem: sem ele, "nenhuma URL"
      // não distingue site vazio de arquivo inteiro reprovado pelo filtro de
      // caminho — e são falhas que o painel precisa separar.
      throw new Error(`redetorrent-cardigann: a descoberta não gerou URL de obra (${all.length} URL(s) lida(s))`);
    }
    return {
      urls,
      complete,
      failures,
      completeByKind: { movie: !failedKinds.has('movie'), tv_show: !failedKinds.has('tv_show') },
      requestCost: counter.n,
    };
  };
}
