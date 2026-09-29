// Descoberta do BLUDV: índice de sitemaps → `post-sitemap*.xml` → obras com
// `lastmod` e tipo pelo slug. É a metade "para cima" do adaptador
// (`bludv.ts` cuida da leitura da página), extraída pelo mesmo motivo que o
// RedeTorrent tem `redetorrent-discover.ts` e o TorrentDosFilmes tem
// `torrentdosfilmes-discovery.ts`: a fábrica do `CrawlSite` é um arquivo só e as
// duas metades já não cabiam no teto de linhas.
//
// Nada aqui grava banco, agenda nada nem liga o crawler. A medição que
// justifica as regras está no cabeçalho de `bludv-discovery.ts`.
//
// A REGRA DURA que este módulo existe para sustentar: `urls: []` com
// `complete: true` NUNCA sai daqui. Essa combinação faz o cursor do crawler
// avançar por cima de um acervo que ninguém leu — 17.860 páginas, no pior caso —
// e ela é silenciosa por definição. Corpo que o parser não reconhece, arquivo
// sem NENHUMA entrada e arquivo sem URL de obra viram FALHA (parcial com
// `failures`, ou exceção quando não sobrou fonte nenhuma), nunca rodapé "vazio e
// completo".
//
// Diferença de estrutura em relação ao RedeTorrent: lá o sitemap de SÉRIE é um
// arquivo separado, e desligar as séries economiza uma requisição por rodada.
// Aqui o `post-sitemap*` é MISTO (3.236 das 17.860 linhas são de temporada), então
// não há arquivo de série para pular: com séries desligadas o arquivo é lido do
// mesmo jeito e o corte é pelo TIPO DA LINHA, na saída. É a mesma forma do
// TorrentDosFilmes — e é por isso que o portão das séries é aplicado sobre a
// lista final, não sobre o plano de leitura.
import type {
  CrawlDiscoverOptions, CrawlDiscovery, CrawlPageKind, DiscoveredUrl,
} from '../crawl-types.js';
// Tipo do adaptador: importado só para a assinatura, e apagado na compilação —
// não existe aresta de runtime entre os dois arquivos.
import type { BludvResolverSurface } from './bludv.js';
import * as log from '../../utils/logger.js';
import {
  isSitemapXml, kindFromSlug, parseSitemapEntries, parseSitemapIndexLocs,
  SITEMAP_INDEX_PATHS, toWorkUrl,
} from './bludv-discovery.js';

/** A assinatura de `CrawlSite.discover` que este módulo entrega. */
export type BludvDiscover = (since?: string | null, opts?: CrawlDiscoverOptions) => Promise<CrawlDiscovery>;

/** Motivo de recusa compartilhado, para o log e para o painel lerem igual. */
const SHAPE_MOTIVE = 'formato de sitemap não reconhecido (nem XML de sitemap)';

/**
 * Fábrica da descoberta. `seriesProbe` é o MODO AMOSTRA (o mesmo booleano que a
 * fábrica do adaptador aplica a `fetchWork`): sem ele E sem a opção de séries do
 * painel, nenhum `tv_show` é emitido.
 */
export function createBludvDiscoverer(surface: BludvResolverSurface, seriesProbe: boolean): BludvDiscover {
  /**
   * Índice de sitemaps: o canônico que o `robots.txt` declara
   * (`/sitemap_index.xml`, Yoast) e os dois nomes que são 301 para ele. Precisa
   * renderizar ao menos um `post-sitemap*` para valer como resposta — o índice
   * real tem 54 entradas e só 18 são de obra, então "veio resposta" não basta. O
   * motivo viaja na falha, porque "formato não reconhecido" e "índice sem sitemap
   * de obra" são defeitos de coisas diferentes.
   *
   * O `onRequest` é disparado ANTES de cada chamada, e não por um hook do
   * profile: o `fetchText` do BLUDV tem aridade 2 e não aceita `hooks` (medido —
   * o RedeTorrent tem 3). Uma chamada é um acesso e o solve do FlareSolverr é o
   * MESMO acesso, então contar a chamada é a semântica do hook, sem depender de
   * um parâmetro que este profile não tem.
   */
  async function readSitemapIndex(onRequest: () => void): Promise<string> {
    const base = surface.siteSelector.url();
    const failures: string[] = [];
    for (const p of SITEMAP_INDEX_PATHS) {
      const url = new URL(p, base).href;
      try {
        onRequest();
        const xml = await surface.fetchText(url);
        if (parseSitemapIndexLocs(xml, base, (h) => surface.isDetailHost(h)).length) return xml;
        failures.push(`${url}: ${isSitemapXml(xml) ? 'nenhum post-sitemap no índice' : SHAPE_MOTIVE}`);
      } catch (err) {
        failures.push(`${url}: ${log.errorMessage(err)}`);
      }
    }
    throw new Error(`bludv-cardigann: índice de sitemaps ilegível (${failures.join(' | ')})`);
  }

  /**
   * Um `post-sitemap*.xml`: as obras (URL + lastmod + kind pelo slug). O corte
   * incremental é POR KIND (`sinceOf`) — o tipo vem do slug, e os cursores de
   * filme e de série andam separados para um não cortar o outro.
   *
   * As duas recusas viram ERRO (e não lista vazia), porque cada uma é a forma
   * silenciosa de o cursor avançar sobre acervo nunca lido:
   *   1. resposta em formato que o parser não entende (quebra de layout ou
   *      interstitial 200);
   *   2. sitemap lido, mas sem NENHUMA entrada (o arquivo real tem ~1.000);
   *   3. entradas existem, mas nenhuma é página de obra — o `post-sitemap.xml`
   *      inclui a home `/` na primeira linha, e um arquivo inteiro reprovado
   *      pelo filtro de caminho é a mesma falha sem o nome.
   * A contagem é feita ANTES do corte incremental, senão uma rodada em que tudo
   * já foi processado acusaria falha em todos os 18 arquivos.
   *
   * O `onRequest` é disparado ANTES da chamada, e não por hook do profile: o
   * `fetchText` do BLUDV tem aridade 2 e não aceita `hooks` (medido). Uma
   * chamada é um acesso; o solve do FlareSolverr é o MESMO acesso.
   */
  async function readWorkSitemap(
    loc: string,
    sinceOf: (kind: CrawlPageKind) => string | null,
    onRequest: () => void,
  ): Promise<DiscoveredUrl[]> {
    onRequest();
    const xml = await surface.fetchText(loc);
    if (!isSitemapXml(xml)) throw new Error(SHAPE_MOTIVE);
    const rows = parseSitemapEntries(xml);
    if (!rows.length) throw new Error('sitemap sem nenhuma entrada');
    const out: DiscoveredUrl[] = [];
    let rowsOfWork = 0;
    for (const row of rows) {
      // Loc de post é INPUT do site: a home `/` (que o índice do site inclui) e
      // qualquer host de fora saem aqui, sem virar requisição nem fila.
      const href = toWorkUrl(row.loc, loc, (h) => surface.isDetailHost(h));
      if (!href) continue;
      rowsOfWork += 1;
      const kind = kindFromSlug(href);
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
    if (!rowsOfWork) {
      throw new Error(`sitemap sem URL de obra (${rows.length} entrada(s), nenhuma de página de post)`);
    }
    return out;
  }

  return async function discover(since?: string | null, opts?: CrawlDiscoverOptions): Promise<CrawlDiscovery> {
    // Séries ligadas (opção do painel) ou modo amostra emitem `tv_show`. Sem isso
    // a lista é de filmes e o cursor de série não anda (sem URL do kind não há
    // `max`) — é o mesmo portão dos outros sites do motor. O post deste site
    // declara UMA temporada, e a locação de cada botão é lida no `fetchWork`
    // (`seasonPageGroups`).
    const emitSeries = seriesProbe || opts?.series?.enabled === true;
    const sinceByKind = opts?.sinceByKind;
    const sinceOf = (kind: CrawlPageKind): string | null => (
      sinceByKind && Object.prototype.hasOwnProperty.call(sinceByKind, kind)
        ? (sinceByKind[kind] ?? null)
        : (since ?? null)
    );
    // Custo REAL da rodada (F3, por chamada): índice + um fetch por `post-sitemap*`
    // (18 no acervo real, ~1.000 linhas cada). Sem isto a descoberta entraria de
    // graça no teto por hora, que é de requisições. O solve do FlareSolverr NÃO
    // soma — ele é o mesmo acesso, dentro da chamada contada.
    const counter = { n: 0 };
    const countRequest = () => { counter.n += 1; };
    const base = surface.siteSelector.url();
    const indexXml = await readSitemapIndex(countRequest);
    const sitemaps = parseSitemapIndexLocs(indexXml, base, (h) => surface.isDetailHost(h));
    if (!sitemaps.length) throw new Error('bludv-cardigann: nenhum post-sitemap no índice');
    // Sequencial (constraint crawl.search_isolation): um pedido por vez. Sitemap
    // que falha não derruba a rodada — vira descoberta PARCIAL, e o cursor não
    // avança por cima do que ficou nos arquivos perdidos. O `post-sitemap*` é
    // MISTO, então um arquivo que falhou tira a fonte dos DOIS kinds: não dá para
    // dizer qual deles ele alimentava.
    const all: DiscoveredUrl[] = [];
    const failures: string[] = [];
    for (const loc of sitemaps) {
      try {
        all.push(...await readWorkSitemap(loc, sinceOf, countRequest));
      } catch (err) {
        failures.push(`${loc}: ${log.errorMessage(err)}`);
        log.warn(`[crawl] bludv-cardigann: sitemap falhou (${loc}):`, log.errorMessage(err));
      }
    }
    if (failures.length === sitemaps.length) {
      throw new Error('bludv-cardigann: todos os post-sitemaps falharam');
    }
    const complete = failures.length === 0;
    const urls = emitSeries ? all : all.filter((u) => u.kind === 'movie');
    if (!urls.length) {
      // O contador de entradas lidas entra na mensagem: sem ele, "nenhuma URL" não
      // distingue site vazio de arquivo inteiro reprovado pelo filtro de caminho —
      // e são falhas que o painel precisa separar.
      throw new Error(`bludv-cardigann: a descoberta não gerou URL de obra (${all.length} URL(s) lida(s))`);
    }
    return {
      urls,
      complete,
      failures,
      completeByKind: { movie: complete, tv_show: emitSeries ? complete : true },
      requestCost: counter.n,
    };
  };
}
